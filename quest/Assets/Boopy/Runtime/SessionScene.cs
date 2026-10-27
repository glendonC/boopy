#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>
    /// The interpretation in the room: an outline on the subject, labels beside protected object
    /// envelopes, and source leader lines. Controls reserve their own space. Placements stay in
    /// the room; a new interpretation or changed label only moves a placement that now conflicts.
    /// </summary>
    public sealed class SessionScene : MonoBehaviour
    {
        private readonly Dictionary<string, Chip> chips = new Dictionary<string, Chip>();
        private readonly Dictionary<string, Snapshot> snapshots = new Dictionary<string, Snapshot>();
        private RoomCamera? room;
        private Transform? head;
        private Mesh? quad;
        private readonly Dictionary<string, GroundedOverlay> overlays = new Dictionary<string, GroundedOverlay>();
        // A subject on a recorded picture carries its word in the picture's plane instead of a chip in front of it.
        private readonly Dictionary<string, WordBlock> words = new Dictionary<string, WordBlock>();
        // A subject on a recorded picture whose only shape is the model's loose box carries a pin where the person pointed.
        private readonly Dictionary<string, BoopPin> pins = new Dictionary<string, BoopPin>();
        // Where the person pointed on each recorded observation, from the turn's own cue.
        private readonly Dictionary<string, Point2> pointed = new Dictionary<string, Point2>();
        // The objects the outline run proposed on one recorded frame: Boopy's line keeps off them on that frame only.
        private string? outlinedFrame;
        private IReadOnlyList<RecordedOutlineObject> outlinedObjects = Array.Empty<RecordedOutlineObject>();
        // The last home found and what it was found for: it is searched again only when one of those changes.
        private int homeKey;
        private RecordingSpot? homeFound;
        private RecordedPicture? picture;
        private readonly ObjectAccents accents = new ObjectAccents();
        private string? focusedItemId;
        private SessionView? renderedView;
        private InteractionPresentation? task;
        private string? renderedSessionId, renderedReferentId;
        private readonly HashSet<string> groundedItems = new HashSet<string>();
        private Vector3? referentPoint;
        private bool booping;
        private ContextConsole? console;
        private bool layoutReady;
        private bool followingConsole;
        // From the pinch until the answer has shown, the console holds the turn's place: only the reply's own objects move it.
        private bool turnOpen;
        private bool reducedMotion;
        private Vector3 layoutEyes;
        private Vector3 layoutForward;
        private Vector3 layoutRight;
        private Vector3 layoutUp;
        private readonly List<LabelRect> protectedAreas = new List<LabelRect>();
        private readonly List<N.Vector3[]> protectedWorld = new List<N.Vector3[]>();
        private static readonly LabelRect ViewBounds = new LabelRect(-0.9f, -0.65f, 0.9f, 0.65f);
        private const float LabelDistance = 1f;
        private const float LabelGap = 0.025f;
        public bool ConsolePlaced { get; private set; }
        /// <summary>The console's home in the view: right of center, a little down, where the layout places it first.</summary>
        public static readonly N.Vector2 ConsoleHome = new N.Vector2(0.55f, -0.05f);

        public static SessionScene Create(Transform parent, RoomCamera room, Transform head)
        {
            var go = new GameObject("Session");
            go.transform.SetParent(parent, false);
            var scene = go.AddComponent<SessionScene>();
            scene.room = room;
            scene.head = head;
            scene.quad = Visuals.Quad();
            return scene;
        }

        /// <summary>Keeps a frame's pose and depth, so items grounded in it can be placed in the room.</summary>
        public void Remember(string observationId, Snapshot snapshot, Point2? pointedAt = null)
        {
            snapshots[observationId] = snapshot;
            if (pointedAt != null) pointed[observationId] = pointedAt; else pointed.Remove(observationId);
        }

        /// <summary>Current-view envelopes of actual conversation evidence, labels and global controls.</summary>
        public void AppendPresentationKeepouts(List<LabelRect> occupied, ContextConsole controls)
        {
            if (head == null) return;
            var viewer = new HeadPose(ToNumerics(head.position), ToNumerics(head.forward));
            foreach (var boundary in protectedWorld)
                if (ProjectedKeepout.TryEnvelope(boundary, viewer, out var area)) occupied.Add(area);
            foreach (var chip in chips.Values)
            {
                if (!chip.gameObject.activeInHierarchy) continue;
                chip.Face(head);
                var half = chip.LayoutSize * .5f;
                var corners = new[] { new Vector3(-half.x, -half.y, 0f), new Vector3(half.x, -half.y, 0f),
                    new Vector3(half.x, half.y, 0f), new Vector3(-half.x, half.y, 0f) };
                if (ProjectedKeepout.TryEnvelope(corners.Select(point => ToNumerics(chip.transform.TransformPoint(point))).ToArray(), viewer, out var label))
                    occupied.Add(label);
            }
            if (!controls.gameObject.activeInHierarchy) return;
            var center = controls.transform.position + controls.transform.up * controls.LayoutCenterOffset;
            var size = controls.LayoutSize * .5f;
            var right = controls.transform.right * size.x; var up = controls.transform.up * size.y;
            var controlCorners = new[] { center - right - up, center + right - up, center + right + up, center - right + up };
            if (ProjectedKeepout.TryEnvelope(controlCorners.Select(ToNumerics).ToArray(), viewer, out var footprint)) occupied.Add(footprint);
        }

        /// <summary>The recorded picture that shows, or null: its still's luminance sets the words' ink, and a turn about it
        /// docks the console beside it.</summary>
        public void SetPicture(RecordedPicture? shown) => picture = shown;

        public void SetReducedMotion(bool on)
        {
            reducedMotion = on;
            foreach (var chip in chips.Values) chip.SetReducedMotion(on);
            foreach (var overlay in overlays.Values) overlay.SetReducedMotion(on);
        }

        /// <summary>Attach controls and reserve their rectangle; false means no clear forward placement exists.</summary>
        public bool PlaceConsole(ContextConsole controls)
        {
            console = controls;
            EnsureLayoutFrame();
            if (!layoutReady) return false;
            var occupied = new List<LabelRect>();
            return ReserveConsole(occupied);
        }

        /// <summary>
        /// The console's home for a head pose: its layout box at <see cref="ConsoleHome"/> in that pose's frame, placed
        /// through its anchor as ReserveConsole places it. The turn's place and the room re-anchor share it.
        /// </summary>
        public static Vector3 HomeFor(Transform head, ContextConsole controls)
        {
            var forward = head.forward.normalized;
            var right = Vector3.Cross(Vector3.up, forward).normalized;
            if (right.sqrMagnitude < 0.01f) right = head.right.normalized;
            var up = Vector3.Cross(forward, right).normalized;
            var center = head.position + (forward + right * ConsoleHome.X + up * ConsoleHome.Y).normalized * LabelDistance;
            return Anchor(head, center, controls.LayoutCenterOffset);
        }

        /// <summary>True while a recording shows: Boopy keeps to his home on it.</summary>
        public bool OnRecording => picture != null && picture.Showing;

        /// <summary>
        /// Boopy's home on a recording: where the console goes, which home that is, and what it still crowds when no home is
        /// clear (null when it is clear).
        /// </summary>
        public readonly struct RecordingSpot
        {
            public RecordingSpot(Vector3 position, string name, string? crowds, bool mirrored)
            {
                Position = position; Name = name; Crowds = crowds; Mirrored = mirrored;
            }
            public Vector3 Position { get; }
            public string Name { get; }
            public string? Crowds { get; }
            /// <summary>Boopy sits right of his caption there, away from a subject on its left.</summary>
            public bool Mirrored { get; }
            public bool Clear => Crowds == null;
            public override string ToString() => Name + (Mirrored ? ", Boopy right of his line" : ", Boopy left of his line")
                + (Crowds == null ? ", clear" : ", not clear: it crowds " + Crowds);
        }

        /// <summary>The objects the outline run proposed on a recorded frame; Boopy's line keeps off them while that frame is held.</summary>
        public void SetOutlined(string frameId, IReadOnlyList<RecordedOutlineObject> objects)
        {
            outlinedFrame = frameId; outlinedObjects = objects;
        }

        /// <summary>
        /// Over a recording, Boopy's home on it. What of him is drawn (his body, his caption and its hint, and their shadows)
        /// stays inside the frame's sharp part and clear of every keep-out (<see cref="RecordingKeepouts"/>), as seen from the
        /// eye at the placement, by one caption line (the keepout margin when that is more). The homes are tried in order:
        /// right of the frame's middle and a little down, as in the room, lower right, left, lower left, below, upper right,
        /// upper left; then spots across the sharp part, nearest the first home first. With none clear, the spot that covers
        /// the least of a person, then the least of the rest, and the spot says so: Boopy is never hidden over a recording.
        /// At each, Boopy sits on the side of his caption away from the subject (its outline or pin, else its word), where
        /// his caption lies to one side of it. The
        /// answer depends only on what is drawn and the keep-outs, never on where he sits now. Null with no recording shown.
        /// </summary>
        public RecordingSpot? RecordingHome(ContextConsole controls)
        {
            if (picture == null || !picture.Showing) return null;
            var sharp = picture.Sharp;
            var (plain, plainCaption, beside, besideCaption) = Footprints(controls);
            var gap = KeepClear(controls);
            var found = RecordingKeepouts();
            subjectAcross = found.Where(keepout => keepout.What == "the pin" || keepout.What == "the subject's shape").Concat(found)
                .Select(keepout => (float?)keepout.Area.center.x).FirstOrDefault();
            var keepouts = found.Select(keepout => (Area: Grown(keepout.Area, gap), keepout.What)).ToList();
            var key = HomeKey(plain, plainCaption, beside, besideCaption, keepouts);
            if (key == homeKey && homeFound != null) return homeFound;
            var homes = new List<(string Name, float X, float Y)>
            {
                ("right", ConsoleHome.X, ConsoleHome.Y), ("lower right", ConsoleHome.X, -sharp.Down), ("left", -ConsoleHome.X, ConsoleHome.Y),
                ("lower left", -ConsoleHome.X, -sharp.Down), ("below", 0f, -sharp.Down), ("upper right", ConsoleHome.X, sharp.Up),
                ("upper left", -ConsoleHome.X, sharp.Up),
            };
            const int Across = 12, Upward = 6;
            homes.AddRange(Enumerable.Range(0, (Across + 1) * (Upward + 1))
                .Select(at => (X: Mathf.Lerp(-sharp.Left, sharp.Right, at % (Across + 1) / (float)Across), Y: Mathf.Lerp(-sharp.Down, sharp.Up, at / (Across + 1) / (float)Upward)))
                .OrderBy(at => (at.X - ConsoleHome.X) * (at.X - ConsoleHome.X) + (at.Y - ConsoleHome.Y) * (at.Y - ConsoleHome.Y))
                .Select(at => ($"the spot at {at.X:+0.00;-0.00} across, {at.Y:+0.00;-0.00} up", at.X, at.Y)));
            RecordingSpot? least = null, any = null;
            var leastOverlap = (Person: float.MaxValue, All: float.MaxValue);
            foreach (var (name, x, y) in homes)
            {
                // Boopy goes on the side of his caption away from the subject: right of it when the caption, fitted there,
                // is right of the subject. A spot where neither side is away from it is passed over.
                foreach (var mirrored in subjectAcross == null ? new[] { false } : new[] { false, true })
                {
                    var shape = mirrored ? beside : plain;
                    var line = mirrored ? besideCaption : plainCaption;
                    var (position, seen) = Fit(shape, x, y, sharp);
                    any ??= new RecordingSpot(position, name, "the subject's side", mirrored);
                    // A caption across the subject's middle has no side away from it: either way is his.
                    var from = seen.center.x + (line.xMin - shape.center.x) / LabelDistance;
                    var to = seen.center.x + (line.xMax - shape.center.x) / LabelDistance;
                    if (subjectAcross is float middle && (middle < from || middle > to) && (from + to) / 2f > middle != mirrored) continue;
                    var crowded = keepouts.Where(keepout => keepout.Area.Overlaps(seen)).ToList();
                    if (crowded.Count == 0) return Found(key, new RecordingSpot(position, name, null, mirrored));
                    var overlap = (Person: crowded.Where(keepout => keepout.What == "a person").Sum(keepout => Overlap(keepout.Area, seen)),
                        All: crowded.Sum(keepout => Overlap(keepout.Area, seen)));
                    if (overlap.Person < leastOverlap.Person || overlap.Person == leastOverlap.Person && overlap.All < leastOverlap.All)
                    {
                        leastOverlap = overlap;
                        least = new RecordingSpot(position, name, string.Join(" and ", crowded.Select(keepout => keepout.What).Distinct()), mirrored);
                    }
                    break;
                }
            }
            return Found(key, least ?? any);
        }

        // How far Boopy and his line keep from every keep-out, in tangents: one caption line, the keepout margin when that is
        // more, and 5 mm for his body's depth, which a flat footprint does not see.
        private static float KeepClear(ContextConsole controls) =>
            (Mathf.Max(SpatialTheme.KeepoutMargin * controls.ComfortScale, controls.CaptionLineHeight) + .005f) / LabelDistance;

        // How long a reply's layout must hold still before Boopy chooses his home for it: its parts are all known by then.
        private const float SettleSeconds = .25f;
        // When Boopy last moved on the recording, which side of the subject he left then, and whether this reply's home is chosen.
        private float movedAt = float.NegativeInfinity, clock, stableSince;
        private bool? sideLeft;
        private bool homeChosen;
        private int stableKey;
        // The subject's middle across, as last seen from the recording's eye; the frame's middle without one.
        private float? subjectAcross;

        /// <summary>
        /// Over a recording, Boopy keeps to his home on it (DESIGN, ROOT). It is chosen once a reply's parts are all known
        /// (<paramref name="settled"/>: nothing more is arriving, and the layout has held still for a quarter second), and
        /// he goes there by fade and stays. After that he moves only when where he is stops being clear of the keep-outs or
        /// inside the sharp part, at most once a second and never back to the side he just left within 2 s. With no home
        /// clear his caption wraps narrower first. The log names each move. He is never hidden there: the console stays
        /// placed, his line stays with him, and it faces the eye. False with no recording shown.
        /// </summary>
        public bool KeepRecordingHome(ContextConsole controls, float now, bool settled)
        {
            if (!KeepPlaced(controls)) return false;
            clock = now;
            if (controls.Relocating || controls.Visiting) return true;
            controls.FaceWearer();
            if (!settled || RecordingHome(controls) is not RecordingSpot home) return true;
            if (homeKey != stableKey) { stableKey = homeKey; stableSince = now; return true; }
            var clearHere = PlaceClear(controls);
            if (now - stableSince < SettleSeconds || homeChosen && clearHere || now - movedAt < 1f) return true;
            // One step a frame: the narrower caption and its shadows are drawn, and measured, on the next.
            if (!home.Clear && controls.NarrowCaption()) return true;
            homeChosen = true;
            // Within 3 cm of his home is there, while where he is stays clear; out of bounds even a centimetre is not.
            if (Vector3.Distance(home.Position, controls.transform.position) <= (clearHere ? .03f : .001f) && home.Mirrored == controls.Mirrored) return true;
            var here = RightOfSubject(controls.transform.position);
            if (RightOfSubject(home.Position) == sideLeft && sideLeft != here && now - movedAt < 2f) { homeChosen = false; return true; }
            Move(controls, home, here);
            return true;
        }

        private void Move(ContextConsole controls, RecordingSpot home, bool here)
        {
            sideLeft = here; movedAt = clock;
            controls.Relocate(home.Position, home.Mirrored);
            Debug.Log("Boopy: home on the recording " + home + ".");
        }

        // Over a recording the console stays placed and shown, wherever it is; false with no recording shown.
        private bool KeepPlaced(ContextConsole controls)
        {
            if (picture == null || !picture.Showing) return false;
            console = controls;
            ConsolePlaced = true; followingConsole = true;
            return true;
        }

        // Whether the console, as drawn where it is, still lies inside the frame's sharp part and clear of every keep-out.
        private bool PlaceClear(ContextConsole controls)
        {
            var (plain, _, beside, _) = Footprints(controls);
            var seen = Seen(controls.Mirrored ? beside : plain, controls.transform.position);
            var sharp = picture!.Sharp;
            var gap = KeepClear(controls);
            return seen.xMin >= -sharp.Left - 1e-3f && seen.xMax <= sharp.Right + 1e-3f && seen.yMin >= -sharp.Down - 1e-3f && seen.yMax <= sharp.Up + 1e-3f
                && !RecordingKeepouts().Any(keepout => Grown(keepout.Area, gap).Overlaps(seen));
        }

        // Whether a place lies right of the subject's middle (else of the frame's) as seen from the recording's eye.
        private bool RightOfSubject(Vector3 position)
        {
            var seen = Quaternion.Inverse(picture!.Facing) * (position - picture.Eye);
            return seen.x / seen.z > (subjectAcross ?? 0f);
        }

        /// <summary>
        /// What Boopy keeps clear of on a recording, as seen from the eye at its placement in tangents across and up: each
        /// shown subject's outline (its extent), each pin where the person pointed, and each shown word block. A loose model
        /// box is no shape Boopy knows, so it keeps nothing clear.
        /// </summary>
        public List<(Rect Area, string What)> RecordingKeepouts()
        {
            var keepouts = new List<(Rect Area, string What)>();
            if (picture == null || !picture.Showing) return keepouts;
            if (renderedView != null)
                foreach (var item in renderedView.Items)
                {
                    if (!overlays.TryGetValue(item.Id, out var outline) || !outline.gameObject.activeInHierarchy
                        || !Geometry.TryContour(item.Grounding, out var shape) || PictureOf(item) is not PicturePlane plane) continue;
                    keepouts.Add((SeenOnPicture(plane, shape.Min(point => point.X), shape.Min(point => point.Y), shape.Max(point => point.X), shape.Max(point => point.Y)),
                        "the subject's shape"));
                }
            // Every other thing the reply places on this picture (a person, a tent), by its outline's extent or its box, and every
            // object the outline run proposed on the held frame; but not one covering more than a third of the frame (the
            // dune): there would be nowhere left (DESIGN, ROOT).
            if (renderedView != null)
            {
                var subject = task != null ? PresentedSubject(renderedView) : focusedItemId ?? PresentedSubject(renderedView);
                foreach (var item in renderedView.Items)
                {
                    if (item.Id == subject || !groundedItems.Contains(item.Id) || PictureOf(item) is not PicturePlane plane) continue;
                    var shape = Geometry.Outline(item.Grounding);
                    if (shape.Length == 0) continue;
                    float x0 = shape.Min(point => point.X), y0 = shape.Min(point => point.Y), x1 = shape.Max(point => point.X), y1 = shape.Max(point => point.Y);
                    if ((x1 - x0) * (y1 - y0) > 1f / 3f) continue;
                    keepouts.Add((SeenOnPicture(plane, x0, y0, x1, y1), Person(item.Label) ? "a person" : "a thing in the reply"));
                }
            }
            if (picture.Scene?.FrameId is string held && held == outlinedFrame)
                foreach (var outlined in outlinedObjects)
                    if (outlined.Extent() is Box2 extent && (extent.X1 - extent.X0) * (extent.Y1 - extent.Y0) <= 1f / 3f)
                        keepouts.Add((SeenOnPicture(picture.Plane, extent.X0, extent.Y0, extent.X1, extent.Y1), "an outlined object"));
            foreach (var pin in pins.Values)
                if (pin.gameObject.activeInHierarchy) keepouts.Add((SeenFromEye(pin.transform, pin.Size), "the pin"));
            foreach (var word in words.Values)
                if (word.gameObject.activeInHierarchy) keepouts.Add((SeenFromEye(word.transform, word.Size), "the word"));
            return keepouts;
        }

        /// <summary>
        /// What is drawn under <paramref name="root"/>, each part as the eight world corners of its own bounds on its own
        /// axes. For the console over a recording that is Boopy, his caption and its hint, and their shadows; a text with no
        /// words draws nothing.
        /// </summary>
        public static IEnumerable<Vector3[]> DrawnParts(Component root) => Drawn(root).Select(part => part.Corners);

        /// <summary>As <see cref="DrawnParts"/>, each with its renderer.</summary>
        public static IEnumerable<(Renderer Part, Vector3[] Corners)> Drawn(Component root)
        {
            foreach (var part in root.GetComponentsInChildren<Renderer>())
            {
                if (!part.enabled || !part.gameObject.activeInHierarchy) continue;
                if (part.TryGetComponent<TMP_Text>(out var text) && string.IsNullOrEmpty(text.text)) continue;
                var bounds = part.localBounds;
                if (bounds.size.sqrMagnitude < 1e-10f) continue;
                var corners = new Vector3[8];
                for (var i = 0; i < 8; i++)
                    corners[i] = part.transform.TransformPoint(bounds.center + Vector3.Scale(bounds.extents,
                        new Vector3((i & 1) == 0 ? -1f : 1f, (i & 2) == 0 ? -1f : 1f, (i & 4) == 0 ? -1f : 1f)));
                yield return (part, corners);
            }
        }

        // The console's drawn parts in metres along its own right and up from its position, with Boopy left of his caption
        // (plain) and right of it (beside), each with its caption's own extent. Only the side he sits on is measured; the
        // other is exact all the same: his body mirrors about the pair's middle, and the caption's block moves along, its
        // words left-aligned in it as they are. With nothing drawn, the layout box on both sides.
        private static (Rect Plain, Rect PlainCaption, Rect Beside, Rect BesideCaption) Footprints(ContextConsole controls)
        {
            var at = controls.transform;
            Rect? Measure(IEnumerable<Vector3[]> parts)
            {
                var offsets = parts.SelectMany(part => part)
                    .Select(corner => new Vector2(Vector3.Dot(corner - at.position, at.right), Vector3.Dot(corner - at.position, at.up))).ToList();
                return offsets.Count == 0 ? null : Rect.MinMaxRect(offsets.Min(offset => offset.x), offsets.Min(offset => offset.y), offsets.Max(offset => offset.x), offsets.Max(offset => offset.y));
            }
            bool Under(Renderer part, Component? root) => root != null && part.transform.IsChildOf(root.transform);
            Rect? Union(Rect? a, Rect? b) => a is not Rect one ? b : b is not Rect two ? one
                : Rect.MinMaxRect(Mathf.Min(one.xMin, two.xMin), Mathf.Min(one.yMin, two.yMin), Mathf.Max(one.xMax, two.xMax), Mathf.Max(one.yMax, two.yMax));
            var drawn = Drawn(controls).ToList();
            var body = Measure(drawn.Where(part => Under(part.Part, controls.Companion)).Select(part => part.Corners));
            var line = Measure(drawn.Where(part => Under(part.Part, controls.Caption)).Select(part => part.Corners));
            // Anything else drawn stays where it is on either side.
            var rest = Measure(drawn.Where(part => !Under(part.Part, controls.Companion) && !Under(part.Part, controls.Caption)).Select(part => part.Corners));
            if (body == null && line == null && rest == null)
            {
                var half = controls.LayoutSize / 2f;
                var layout = new Rect(-half.x, controls.LayoutCenterOffset - half.y, 2f * half.x, 2f * half.y);
                return (layout, layout, layout, layout);
            }
            var axis = controls.MirrorAxis; var shift = controls.MirrorShift;
            Rect? Mirror(Rect? side) => side is Rect r ? Rect.MinMaxRect(2f * axis - r.xMax, r.yMin, 2f * axis - r.xMin, r.yMax) : (Rect?)null;
            Rect? Along(Rect? side, float by) => side is Rect r ? new Rect(r.x + by, r.y, r.width, r.height) : (Rect?)null;
            var (plainBody, plainLine, besideBody, besideLine) = controls.Mirrored
                ? (Mirror(body), Along(line, -shift), body, line) : (body, line, Mirror(body), Along(line, shift));
            var plain = Union(Union(plainBody, plainLine), rest)!.Value; var beside = Union(Union(besideBody, besideLine), rest)!.Value;
            return (plain, plainLine ?? plain, beside, besideLine ?? beside);
        }

        // The console with its footprint's middle at tangents (x, y) from the recording's eye, facing that eye, moved inside
        // the frame's sharp part where it would cross its edge (centred on it when it is wider): where it goes, and its
        // footprint as seen from the eye.
        private (Vector3 Position, Rect Seen) Fit(Rect footprint, float x, float y, (float Left, float Right, float Up, float Down) sharp)
        {
            var aim = new Vector2(x, y) - footprint.center / LabelDistance;
            var position = Vector3.zero; var seen = default(Rect);
            for (var pass = 0; pass < 3; pass++)
            {
                position = picture!.Eye + picture.Facing * new Vector3(aim.x, aim.y, 1f).normalized * LabelDistance;
                seen = Seen(footprint, position);
                var shift = new Vector2(Inward(seen.xMin, seen.xMax, -sharp.Left, sharp.Right), Inward(seen.yMin, seen.yMax, -sharp.Down, sharp.Up));
                if (shift.sqrMagnitude < 1e-10f) break;
                aim += shift;
            }
            return (position, seen);
        }

        private RecordingSpot? Found(int key, RecordingSpot? spot) { homeKey = key; homeFound = spot; return spot; }

        // What a home is found for: what of the console is drawn, the keep-outs, and the recording as placed and held.
        private int HomeKey(Rect plain, Rect plainCaption, Rect beside, Rect besideCaption, List<(Rect Area, string What)> keepouts)
        {
            static int Mm(float value) => Mathf.RoundToInt(value * 1000f);
            var hash = new HashCode();
            foreach (var value in new[] { plain.xMin, plain.yMin, plain.xMax, plain.yMax, plainCaption.xMin, plainCaption.xMax,
                beside.xMin, beside.yMin, beside.xMax, beside.yMax, besideCaption.xMin, besideCaption.xMax,
                picture!.Eye.x, picture.Eye.y, picture.Eye.z, picture.Facing.x, picture.Facing.y, picture.Facing.z, picture.Facing.w,
                picture.Sharp.Left, picture.Sharp.Right, picture.Sharp.Up, picture.Sharp.Down })
                hash.Add(Mm(value));
            hash.Add(picture.Scene?.FrameId);
            foreach (var (area, what) in keepouts) { hash.Add(Mm(area.xMin)); hash.Add(Mm(area.yMin)); hash.Add(Mm(area.xMax)); hash.Add(Mm(area.yMax)); hash.Add(what); }
            return hash.ToHashCode();
        }

        // How far a span moves to lie inside low to high; a span wider than that is centred on it.
        private static float Inward(float from, float to, float low, float high) =>
            to - from > high - low ? (low + high - from - to) / 2f : from < low ? low - from : to > high ? high - to : 0f;

        // A footprint (metres along the console's right and up) of a console at a position facing the recording's eye, as seen
        // from that eye in tangents across and up.
        private Rect Seen(Rect footprint, Vector3 position)
        {
            var toward = position - picture!.Eye;
            var right = Vector3.Cross(Vector3.up, toward).normalized; var up = Vector3.Cross(toward.normalized, right);
            var away = Quaternion.Inverse(picture.Facing);
            var corners = new[] { footprint.min, new Vector2(footprint.xMax, footprint.yMin), footprint.max, new Vector2(footprint.xMin, footprint.yMax) }
                .Select(corner => away * (toward + right * corner.x + up * corner.y)).ToArray();
            return Rect.MinMaxRect(corners.Min(corner => corner.x / corner.z), corners.Min(corner => corner.y / corner.z),
                corners.Max(corner => corner.x / corner.z), corners.Max(corner => corner.y / corner.z));
        }

        // A rectangle on a picture (image coordinates from its top-left) as seen from the recording's eye, in tangents.
        private Rect SeenOnPicture(PicturePlane plane, float x0, float y0, float x1, float y1)
        {
            var away = Quaternion.Inverse(picture!.Facing);
            var corners = new[] { plane.At(x0, y0), plane.At(x1, y0), plane.At(x1, y1), plane.At(x0, y1) }
                .Select(corner => away * (new Vector3(corner.X, corner.Y, corner.Z) - picture.Eye)).ToArray();
            return Rect.MinMaxRect(corners.Min(corner => corner.x / corner.z), corners.Min(corner => corner.y / corner.z),
                corners.Max(corner => corner.x / corner.z), corners.Max(corner => corner.y / corner.z));
        }

        private static Rect Grown(Rect area, float by) => Rect.MinMaxRect(area.xMin - by, area.yMin - by, area.xMax + by, area.yMax + by);

        private static float Overlap(Rect a, Rect b) =>
            Mathf.Max(0f, Mathf.Min(a.xMax, b.xMax) - Mathf.Max(a.xMin, b.xMin)) * Mathf.Max(0f, Mathf.Min(a.yMax, b.yMax) - Mathf.Max(a.yMin, b.yMin));

        /// <summary>A flat thing's rectangle as seen from the eye at the recording's placement, in tangents across and up.</summary>
        public Rect SeenFromEye(Transform thing, Vector2 size)
        {
            if (picture == null) return default;
            var corners = new[] { -1f, 1f }.SelectMany(x => new[] { -1f, 1f }.Select(y => Quaternion.Inverse(picture.Facing)
                * (thing.position + thing.right * (x * size.x / 2f) + thing.up * (y * size.y / 2f) - picture.Eye))).ToArray();
            var across = corners.Select(corner => corner.x / corner.z).ToArray(); var upward = corners.Select(corner => corner.y / corner.z).ToArray();
            return Rect.MinMaxRect(across.Min(), upward.Min(), across.Max(), upward.Max());
        }

        /// <summary>
        /// A turn opens at the pinch: the layout frame is taken now, and the console goes to its home in it, or the nearest
        /// spot clear of the objects shown, by fade if it moves. Until the turn closes only the reply's own objects move it.
        /// </summary>
        public void OpenTurn(ContextConsole controls)
        {
            console = controls;
            if (head == null) return;
            layoutReady = false;
            EnsureLayoutFrame();
            if (renderedView != null) ProtectObjects(renderedView);
            turnOpen = true;
            ConsolePlaced = true;
            // Over a recording the console takes its home on the recording, inside its sharp part, never hidden; in the room,
            // its home in this view, or the nearest spot clear of the objects shown.
            // A new reply: its home is chosen again once its parts are known.
            if (RecordingHome(controls) is RecordingSpot home)
            {
                homeChosen = false;
                if (Vector3.Distance(home.Position, controls.Destination) > .03f || home.Mirrored != controls.Mirrored)
                    Move(controls, home, RightOfSubject(controls.transform.position));
                return;
            }
            var place = HomeFor(head, controls);
            if (!FollowFootprintClear(controls, place))
                foreach (var bounds in new[] { ViewBounds, Expanded() })
                    if (TryPlaceElement(controls.LayoutSize, ConsoleHome, new List<LabelRect>(), bounds, out var spot, out _)
                        && FollowFootprintClear(controls, ConsoleAnchor(spot))) { place = ConsoleAnchor(spot); break; }
            controls.Relocate(place);
        }

        /// <summary>The turn closes once its answer has shown: from then on the console stays where it is in the room.</summary>
        public void CloseTurn() { turnOpen = false; followingConsole = true; }

        /// <summary>Keeps the console where it is this frame: the turn's place, or fixed in the room after it.</summary>
        public void HoldConsole(ContextConsole controls)
        {
            console = controls;
            if (controls.Relocating) return;
            if (ConsolePlaced) controls.Place(controls.transform.position);
            UpdateLabelOcclusion(ConsolePlaced);
        }

        /// <summary>After a turn, a home far from the console brings it there by fade, when that home is clear.</summary>
        public void ReanchorConsole(ContextConsole controls, Vector3 home)
        {
            console = controls;
            if (KeepPlaced(controls)) return;
            if (!FollowFootprintClear(controls, home)) { HoldConsole(controls); return; }
            followingConsole = true;
            ConsolePlaced = true;
            controls.Relocate(home);
        }

        /// <summary>The assistant follows the wearer; evidence keeps its original room position.</summary>
        public bool MoveConsole(ContextConsole controls, Vector3 position)
        {
            console = controls;
            if (KeepPlaced(controls)) return true;
            var candidateClear = head == null || FollowFootprintClear(controls, position);
            var currentClear = head == null || FollowFootprintClear(controls, controls.transform.position);
            var decision = ProjectedKeepout.Decide(candidateClear, currentClear);
            if (decision == FollowPlacement.Hold)
            {
                followingConsole = true;
                ConsolePlaced = true;
                controls.Place(controls.transform.position);
                UpdateLabelOcclusion(true);
                return false;
            }
            if (decision == FollowPlacement.Hide)
            {
                // Continue bounded recovery motion invisibly. Freezing an already overlapping
                // sheet would leave it covering the subject and could trap it there indefinitely.
                followingConsole = true;
                ConsolePlaced = false;
                controls.ShowControlsOnly(position);
                UpdateLabelOcclusion(false);
                return false;
            }
            followingConsole = true;
            ConsolePlaced = true;
            console.Place(position);
            UpdateLabelOcclusion(true);
            return true;
        }

        private void UpdateLabelOcclusion(bool overlayVisible)
        {
            if (head == null || console == null) return;
            foreach (var chip in chips.Values)
            {
                if (!chip.gameObject.activeSelf) continue;
                var fromEyes = chip.transform.position - head.position;
                var ray = new Ray(head.position, fromEyes.normalized);
                // Keep room placement intact; temporarily suppress a label behind the reading sheet.
                chip.SetOverlayOccluded(overlayVisible && console.ContainsRay(ray));
            }
        }

        private bool FollowFootprintClear(ContextConsole controls, Vector3 position)
        {
            if (head == null || protectedWorld.Count == 0) return true;
            var viewer = new HeadPose(ToNumerics(head.position), ToNumerics(head.forward));
            var areas = new List<LabelRect>();
            foreach (var boundary in protectedWorld)
                if (ProjectedKeepout.TryEnvelope(boundary, viewer, out var area)) areas.Add(area);
            // Console dimensions are physical, unlike distance-scaled room chips. Include its
            // whole sheet even when the center ray misses the object. Preserve locked facing
            // for an unchanged interaction pose; a moving panel faces the wearer.
            var direction = (position - head.position).normalized;
            var right = controls.InteractionLocked ? controls.transform.right : Vector3.Cross(Vector3.up, direction).normalized;
            if (right.sqrMagnitude < 1e-8f) right = head.right;
            var up = controls.InteractionLocked ? controls.transform.up : Vector3.Cross(direction, right).normalized;
            position += up * controls.LayoutCenterOffset;
            var half = controls.LayoutSize * 0.5f;
            var corners = new[]
            {
                ToNumerics(position - right * half.x - up * half.y),
                ToNumerics(position + right * half.x - up * half.y),
                ToNumerics(position + right * half.x + up * half.y),
                ToNumerics(position - right * half.x + up * half.y),
            };
            // An entirely behind-view panel is invisible, so it can return around the viewing
            // sphere. Near-plane crossings remain protected by the clipped footprint above.
            return !ProjectedKeepout.TryEnvelope(corners, viewer, out var footprint)
                || ProjectedKeepout.IsClear(footprint, areas, LabelGap);
        }

        public Chip? ChipHitBy(Ray ray, float maxDistance, out Vector3 point)
        {
            point = default;
            if (!Physics.Raycast(ray, out var hit, maxDistance)) return null;
            var chip = hit.collider.GetComponent<Chip>();
            if (chip == null) return null;
            point = hit.point;
            return chip;
        }

        /// <summary>
        /// Present one task on the subject already in the room, or return to the session's own
        /// subject with null. The task's chip is its annotation, on the grounded item the annotation
        /// names, placed where that item's session chip goes. An item not grounded in this room gets
        /// no chip and no outline; a chip is never floated in view space.
        /// </summary>
        public void PresentTask(InteractionPresentation? presented)
        {
            task = presented;
            if (renderedView != null) Render(renderedView);
        }

        /// <summary>The grounded item the presented task's chip is on, or null when it has none in this room.</summary>
        public string? TaskSubjectId => task != null ? TaskSubject() : null;

        // A presented task shows only the item its annotation names. Otherwise the session's referent.
        private string? PresentedSubject(SessionView view) => task != null ? TaskSubject()
            : view.ReferentId != null && groundedItems.Contains(view.ReferentId) ? view.ReferentId : null;

        private string? TaskSubject()
        {
            var named = task != null && task.AnnotationEvidenceIds.Count > 0 ? task.AnnotationEvidenceIds[0] : null;
            return named != null && groundedItems.Contains(named) ? named : null;
        }

        // The task's annotation, proposed, as the chip of the item it names: the same item for
        // focus and correction, never the item's own label or verification. It keeps the item's
        // kind, and the item's gloss, confidence and emphasis only while the annotation is the
        // item's own label, so low confidence stays visible.
        private Item Shown(Item item)
        {
            var annotation = task?.ChipItem();
            if (annotation == null) return item;
            annotation.Id = item.Id;
            annotation.Kind = item.Kind;
            if (annotation.Label == item.Label)
            {
                annotation.Gloss = item.Gloss;
                annotation.Confidence = item.Confidence;
                annotation.Emphasis = item.Emphasis;
            }
            return annotation;
        }

        public void Render(SessionView view)
        {
            if (room == null || head == null || quad == null || booping) return;
            // A recovered record without this runtime's capture pose belongs in the reader,
            // not at an invented position in the current room.
            if (renderedSessionId != view.Id || renderedReferentId != view.ReferentId) focusedItemId = null;
            renderedView = view; renderedSessionId = view.Id; renderedReferentId = view.ReferentId;
            groundedItems.Clear();
            foreach (var item in view.Items)
                if (item.Id != view.IntentId && item.Kind != "goal" && item.Kind != "question"
                    && item.Status != "ignored" && item.Status != "rejected" && AnchorOf(item) != null)
                    groundedItems.Add(item.Id);
            if (focusedItemId != null && !groundedItems.Contains(focusedItemId)) focusedItemId = null;
            // Focus can move the session's chip to another item; a task's chip stays on its subject.
            var selectedId = task != null ? PresentedSubject(view) : focusedItemId ?? PresentedSubject(view);
            var worldItems = view.Items.Where(item => item.Id == selectedId && groundedItems.Contains(item.Id)).Take(1).ToList();
            accents.Synchronize(worldItems.Select(item => item.Id).ToArray());
            var outlined = worldItems;
            // A subject on a recorded picture gets its word; any other gets its chip.
            var onPicture = worldItems.Where(item => PictureOf(item) != null).ToList();
            foreach (var gone in words.Keys.Where(id => onPicture.All(item => item.Id != id)).ToList())
            {
                Discard(words[gone].gameObject); words.Remove(gone);
            }
            worldItems = worldItems.Where(item => PictureOf(item) == null).ToList();
            foreach (var gone in chips.Keys.Where(id => worldItems.All(item => item.Id != id)).ToList())
            {
                chips[gone].gameObject.SetActive(false);
                Discard(chips[gone].gameObject);
                chips.Remove(gone);
            }
            var referent = outlined.FirstOrDefault();
            referentPoint = referent == null ? null : AnchorOf(referent);
            DrawOutlines(outlined, view.ReferentId);
            ShowPins(onPicture);
            foreach (var item in onPicture) ShowWord(item);
            EnsureLayoutFrame();
            if (!layoutReady) return;
            ProtectObjects(view);
            var occupied = new List<LabelRect>();
            ReserveConsole(occupied);

            // Update text before measuring. Hidden overflow remains in the session and in the
            // console's review list; its absence in the room never removes an item from context.
            foreach (var item in worldItems)
            {
                if (!chips.TryGetValue(item.Id, out var chip))
                {
                    chip = Chip.Create(transform, quad);
                    chip.SetReducedMotion(reducedMotion);
                    chips[item.Id] = chip;
                }
                chip.gameObject.SetActive(true);
                chip.Show(Shown(item), false);
                chip.SetSubjectOutline(overlays.TryGetValue(item.Id, out var outline) ? outline.Boundary : Array.Empty<Vector3>());
                if (accents.TryGet(item.Id, out var slot)) chip.SetIdentityAccent(slot);
                chip.Focus(item.Id == focusedItemId);
                chip.SetPeerFocused(focusedItemId != null && item.Id != focusedItemId);
            }

            // Keep the existing world positions whenever their full, updated bounds still fit.
            // Corrections may change a label's size; only a conflicting label is moved on Render.
            var waiting = new List<Item>();
            foreach (var item in worldItems)
            {
                var chip = chips[item.Id];
                if (chip.Placed && BillboardBounds(chip.Home, chip.LayoutSize, out var existing)
                    && ClearOfObjectsAndLabels(existing, occupied, ViewBounds))
                {
                    occupied.Add(existing);
                }
                else
                {
                    waiting.Add(item);
                }
            }
            var overflow = view.Items.Count(item => item.Id != view.IntentId) - worldItems.Count - onPicture.Count;
            foreach (var item in waiting)
            {
                var chip = chips[item.Id];
                var anchor = AnchorOf(item);
                var preferred = anchor != null && Project(anchor.Value, out var at) ? at : new N.Vector2(0f, -0.2f);
                if (TryPlaceElement(chip.LayoutSize, preferred, occupied, ViewBounds, out var home, out var envelope))
                {
                    chip.Place(home, anchor);
                    occupied.Add(envelope);
                }
                else
                {
                    chip.gameObject.SetActive(false);
                    overflow++;
                }
            }
            console?.SetOverflow(overflow);
        }

        /// <summary>The currently presented source anchor, never a guessed current-room target.</summary>
        public bool TryGetActiveAnchor(out Vector3 point)
        {
            point = default;
            if (renderedView == null) return false;
            var id = task != null ? PresentedSubject(renderedView) : focusedItemId ?? PresentedSubject(renderedView);
            foreach (var item in renderedView.Items)
                if (item.Id == id && groundedItems.Contains(item.Id) && AnchorOf(item) is Vector3 anchor)
                { point = anchor; return true; }
            return false;
        }

        /// <summary>Where an item's anchor lies in the room, from the frame it was grounded in.</summary>
        private Vector3? AnchorOf(Item item)
        {
            if (room == null) return null;
            var image = Geometry.Anchor(item.Grounding);
            if (image == null || item.Grounding.ObservationId == null) return null;
            if (!snapshots.TryGetValue(item.Grounding.ObservationId, out var snapshot)) return null;
            return room.Place(image.Value, snapshot);
        }

        // The picture an item's still is shown on, when its observation came from a recorded picture.
        private PicturePlane? PictureOf(Item item) => item.Grounding.ObservationId != null
            && snapshots.TryGetValue(item.Grounding.ObservationId, out var snapshot) ? snapshot.Picture : null;

        /// <summary>
        /// The word on a subject in a recorded picture (DESIGN): in the picture's plane, one gap above the subject's outline,
        /// else below, right or left of it, inside the part of the picture in view and never over the subject; its ink read from the still under
        /// it. With a task the word is the task's outside term and Boopy's guess and their source; without one, the guess.
        /// </summary>
        private void ShowWord(Item item)
        {
            if (head == null || PictureOf(item) is not PicturePlane plane) return;
            if (!words.TryGetValue(item.Id, out var word)) { word = WordBlock.Create(transform); words[item.Id] = word; }
            var shown = Shown(item);
            var term = task?.Term;
            // What Boopy remembers of the last attempt at this term, on his line's own turn only.
            var memoryLine = term == null || task!.RepliesToAnswer ? null
                : term.NotHeardLastTime ? WordBlock.Memory : term.HeardLastTime ? WordBlock.HeardMemory : null;
            var eyes = head.position;
            var center = new Vector3(plane.Center.X, plane.Center.Y, plane.Center.Z);
            // The guess reads as Boopy's line says it: "Tent", not "tent" (DESIGN).
            word.Show(term?.Text, Capitalized(shown.Label), term != null ? task!.Detail : null, memoryLine, Vector3.Distance(eyes, center), reducedMotion);
            var outline = Geometry.Outline(item.Grounding);
            if (outline.Length == 0) { word.Hide(); return; }
            float x0 = outline.Min(point => point.X), x1 = outline.Max(point => point.X), y0 = outline.Min(point => point.Y), y1 = outline.Max(point => point.Y);
            var w = word.Size.x / plane.Width; var h = word.Size.y / plane.Height;
            var gap = SpatialTheme.Gap * Vector3.Distance(eyes, center) / plane.Height;
            // On a loose model box the word sits on the pin where the person pointed, half a line from it (DESIGN).
            if (pins.TryGetValue(item.Id, out var pin) && pin.gameObject.activeSelf && pointed.TryGetValue(item.Grounding.ObservationId!, out var pointedAt))
            {
                var rx = pin.Size.x / 2f / plane.Width; var ry = pin.Size.y / 2f / plane.Height;
                x0 = pointedAt.X - rx; x1 = pointedAt.X + rx; y0 = pointedAt.Y - ry; y1 = pointedAt.Y + ry;
                gap = (word.Lines.Count > 0 ? word.Lines[0].height : word.Size.y) / 2f / plane.Height;
            }
            var middle = (x0 + x1) / 2f; var level = (y0 + y1) / 2f;
            // The picture covers the view, so part of it lies past the view's edge: the word stays in the part well in view.
            var (vx0, vy0, vx1, vy1) = picture != null && picture.Showing ? picture.Readable : (0f, 0f, 1f, 1f);
            // Above the subject first, climbing toward the top of the view a gap at a time (a third of the block at least,
            // so a tall picture stays a few dozen spots); then below, right and left of it.
            var spots = new List<N.Vector2>();
            var climb = Mathf.Max(gap, h / 3f);
            for (var y = y0 - gap - h / 2f; y - h / 2f >= vy0; y -= climb) spots.Add(new N.Vector2(middle, y));
            spots.Add(new N.Vector2(middle, y1 + gap + h / 2f));
            spots.Add(new N.Vector2(x1 + gap + w / 2f, level)); spots.Add(new N.Vector2(x0 - gap - w / 2f, level));
            var inside = spots.Where(at => at.X - w / 2f >= vx0 && at.X + w / 2f <= vx1 && at.Y - h / 2f >= vy0 && at.Y + h / 2f <= vy1).ToList();
            // Each line sits on calm pixels, never across busy detail such as a rider's arm or head (DESIGN): the first spot
            // where every line is calm, else the calmest; with no spot in view, above the subject, kept in view.
            var spot = inside.FirstOrDefault(at => Busiest(word, plane, at) <= CalmSpread);
            if (spot == default && inside.Count > 0) spot = inside.OrderBy(at => Busiest(word, plane, at)).First();
            if (spot == default) spot = new N.Vector2(Mathf.Clamp(middle, vx0 + w / 2f, vx1 - w / 2f), Mathf.Clamp(y0 - gap - h / 2f, vy0 + h / 2f, vy1 - h / 2f));
            var away = N.Vector3.Normalize(N.Vector3.Cross(plane.Right, plane.Up));
            var at = plane.At(spot.X, spot.Y, -away, .002f);
            var right = new Vector3(plane.Right.X, plane.Right.Y, plane.Right.Z); var up = new Vector3(plane.Up.X, plane.Up.Y, plane.Up.Z);
            word.transform.SetPositionAndRotation(new Vector3(at.X, at.Y, at.Z), Quaternion.LookRotation(Vector3.Cross(right, up), up));
            if (picture != null && picture.Showing)
            {
                var (darkest, brightest) = picture.LuminanceRange(spot.X - w / 2f, spot.Y - h / 2f, spot.X + w / 2f, spot.Y + h / 2f);
                word.Read(darkest, brightest);
            }
        }

        private static readonly HashSet<string> People = new HashSet<string> { "person", "people", "man", "men", "woman", "women", "child", "boy", "girl" };
        // "man in blue robe" is a person too.
        private static bool Person(string label) => label.ToLowerInvariant().Split(' ', '-').Any(People.Contains);

        /// <summary>
        /// The still's darkest and brightest luminance under a thing on the recording, by where its corners land on the
        /// picture from the recording's eye (AUDIT: each caption line's contrast is measured there). While the clip plays the
        /// frame under it is not measured, so it reads as the worst case, (0, 1); so does a thing off the picture.
        /// </summary>
        public (float Darkest, float Brightest) GroundUnder(Vector3[] corners)
        {
            if (picture == null || !picture.Showing || picture.Playing) return (0f, 1f);
            var plane = picture.Plane; var eye = ToNumerics(picture.Eye);
            float x0 = 1f, y0 = 1f, x1 = 0f, y1 = 0f; var hit = false;
            foreach (var corner in corners)
            {
                if (!plane.TryImage(eye, ToNumerics(corner - picture.Eye), out var x, out var y, out _)) continue;
                x0 = Mathf.Min(x0, x); y0 = Mathf.Min(y0, y); x1 = Mathf.Max(x1, x); y1 = Mathf.Max(y1, y); hit = true;
            }
            return hit ? picture.LuminanceRange(x0, y0, x1, y1) : (0f, 1f);
        }

        private static string Capitalized(string label) =>
            label.Length == 0 ? label : char.ToUpperInvariant(label[0]) + label.Substring(1);

        // A line is calm when the still under it spans at most this much luminance (5th to 95th percentile): sky or sand
        // gradients pass, an arm or a head against the sky does not.
        public const float CalmSpread = .25f;

        // The busiest of a word's lines at an image spot; 0 when there is no still to read. Each line's box is padded by half
        // its height above and below, so detail that only touches a glyph (a raised camera under a letter) counts too.
        private float Busiest(WordBlock word, PicturePlane plane, N.Vector2 at)
        {
            if (picture == null || !picture.Showing) return 0f;
            var busiest = 0f;
            foreach (var line in word.Lines)
            {
                var pad = line.height / 2f / plane.Height;
                float x0 = at.X + line.xMin / plane.Width, x1 = at.X + line.xMax / plane.Width;
                float y0 = at.Y - line.yMax / plane.Height - pad, y1 = at.Y - line.yMin / plane.Height + pad;
                busiest = Mathf.Max(busiest, picture.Spread(x0, y0, x1, y1));
            }
            return busiest;
        }

        /// <summary>
        /// What Boopy heard in the person's answer, on the subject (DESIGN): heard brightens the word and the outline once,
        /// not-heard the word, unclear nothing. False when no word shows.
        /// </summary>
        public bool Assess(string heard)
        {
            var id = renderedView != null ? (task != null ? PresentedSubject(renderedView) : focusedItemId ?? PresentedSubject(renderedView)) : null;
            if (id == null || !words.TryGetValue(id, out var word) || !word.gameObject.activeSelf) return false;
            if (heard == "heard") { word.Brighten(); if (overlays.TryGetValue(id, out var overlay)) overlay.Brighten(); }
            else if (heard == "not-heard") word.Brighten();
            return true;
        }

        /// <summary>Whether a point lies on a shown word, a gap around it included, where a dot would sit on its letters.</summary>
        public bool OnWord(Vector3 point, Vector3 eyes) =>
            words.Values.Any(word => word.Covers(point, SpatialTheme.Gap * Vector3.Distance(eyes, point)));

        /// <summary>Where the presented subject's word is, for Boopy to point at.</summary>
        public bool TryGetWord(out Vector3 position)
        {
            position = default;
            var id = renderedView != null ? (task != null ? PresentedSubject(renderedView) : focusedItemId ?? PresentedSubject(renderedView)) : null;
            if (id == null || !words.TryGetValue(id, out var word) || !word.gameObject.activeSelf) return false;
            position = word.WordPosition;
            return true;
        }

        /// <summary>The available contour, or box, with each point placed from its own coarse depth sample.</summary>
        /// <summary>
        /// The pin on each subject of a recorded picture whose only shape is the model's loose box, where the person pointed
        /// on that observation; none where the point is unknown or a real outline shows.
        /// </summary>
        private void ShowPins(List<Item> onPicture)
        {
            var loose = onPicture.Where(item => !Geometry.TryContour(item.Grounding, out _) && item.Grounding.ObservationId != null
                && pointed.ContainsKey(item.Grounding.ObservationId)).ToList();
            foreach (var gone in pins.Keys.Where(id => loose.All(item => item.Id != id)).ToList())
            {
                Discard(pins[gone].gameObject); pins.Remove(gone);
            }
            if (head == null) return;
            foreach (var item in loose)
            {
                if (PictureOf(item) is not PicturePlane plane) continue;
                var at = pointed[item.Grounding.ObservationId!];
                if (!pins.TryGetValue(item.Id, out var pin)) { pin = BoopPin.Create(transform); pins[item.Id] = pin; }
                var away = N.Vector3.Normalize(N.Vector3.Cross(plane.Right, plane.Up));
                var spot = plane.At(at.X, at.Y, -away, .002f);
                var right = new Vector3(plane.Right.X, plane.Right.Y, plane.Right.Z); var up = new Vector3(plane.Up.X, plane.Up.Y, plane.Up.Z);
                var position = new Vector3(spot.X, spot.Y, spot.Z);
                pin.Show(position, Quaternion.LookRotation(Vector3.Cross(right, up), up), Vector3.Distance(head.position, position), reducedMotion);
            }
        }

        private void DrawOutlines(List<Item> worldItems, string? referentId)
        {
            if (room == null) return;
            // On a recorded picture only a real outline is drawn: a loose model box claims a shape Boopy does not know (DESIGN).
            var items = worldItems
                .Where(item => Geometry.Outline(item.Grounding).Length >= 3 &&
                    item.Grounding.ObservationId != null && snapshots.ContainsKey(item.Grounding.ObservationId)
                    && (PictureOf(item) == null || Geometry.TryContour(item.Grounding, out _))).ToList();
            foreach (var gone in overlays.Keys.Where(id => items.All(item => item.Id != id)).ToList())
            {
                overlays[gone].gameObject.SetActive(false);
                Discard(overlays[gone].gameObject); overlays.Remove(gone);
            }
            foreach (var item in items)
            {
                var observation = item.Grounding.ObservationId;
                if (observation == null || !snapshots.TryGetValue(observation, out var snapshot)) continue;
                if (!overlays.TryGetValue(item.Id, out var overlay))
                { overlay = GroundedOverlay.Create(transform, attended: true); overlay.SetReducedMotion(reducedMotion); overlays[item.Id] = overlay; }
                var positions = room.PlaceBoundary(item.Grounding, snapshot, out var capturedDepth);
                overlay.SetFocus(item.Id == focusedItemId, focusedItemId != null);
                var appeared = overlay.Show(item.Grounding, positions, capturedDepth, item.Id == referentId, head != null ? head.position : (Vector3?)null);
                overlay.SetFootage(snapshot.Picture != null);
                if (head != null) overlay.SetViewer(head.position);
                // An outline that first appears gets one sweep, from Boopy's side.
                if (appeared) overlay.Sweep(console != null ? console.transform.position : head != null ? head.position : transform.position);
            }
        }

        private const float VisitClearance = .1f, ViewCenter = .15f;

        /// <summary>
        /// Where Boopy goes while it works on the attended subject: beside its outline as seen from the eyes, on the
        /// side toward <paramref name="home"/> unless that is the center of the view, else the other side. Never over
        /// the outline and never in the view's center.
        /// </summary>
        public bool TryGetSubjectVisit(Vector3 home, out Vector3 visit, out Vector3 anchor, out IReadOnlyList<Vector3> outline)
        {
            visit = default; anchor = default; outline = Array.Empty<Vector3>();
            if (head == null || !TryGetActiveAnchor(out anchor) || Subject() is not GroundedOverlay overlay || overlay.Boundary.Count < 3) return false;
            outline = overlay.Boundary;
            var eyes = head.position;
            var forward = head.forward;
            var right = Vector3.Cross(Vector3.up, forward).normalized;
            if (right.sqrMagnitude < .01f) right = head.right;
            var up = Vector3.Cross(forward, right).normalized;
            var reach = 0f;
            foreach (var point in outline) reach = Mathf.Max(reach, Mathf.Abs(Vector3.Dot(point - anchor, right)));
            var preferred = Vector3.Dot(home - anchor, right) >= 0f ? 1f : -1f;
            foreach (var side in new[] { preferred, -preferred })
            {
                // Beside the outline with room for Boopy, then nearer along its own sight line so it stays beside it in view.
                var point = eyes + (anchor + right * side * (reach + VisitClearance) - eyes) * .85f;
                var sight = point - eyes;
                var depth = Vector3.Dot(sight, forward);
                if (depth <= .1f) continue;
                if (Mathf.Abs(Vector3.Dot(sight, right) / depth) < ViewCenter && Mathf.Abs(Vector3.Dot(sight, up) / depth) < ViewCenter) continue;
                visit = point;
                return true;
            }
            return false;
        }

        /// <summary>One sweep across the attended subject from <paramref name="from"/>'s side.</summary>
        public void SweepSubject(Vector3 from) => Subject()?.Sweep(from);
        public float? SubjectSweepProgress => Subject()?.SweepProgress;

        private GroundedOverlay? Subject()
        {
            if (renderedView == null) return null;
            var id = task != null ? PresentedSubject(renderedView) : focusedItemId ?? PresentedSubject(renderedView);
            return id != null && overlays.TryGetValue(id, out var overlay) && overlay.gameObject.activeSelf ? overlay : null;
        }

        private void EnsureLayoutFrame()
        {
            if (layoutReady || head == null) return;
            layoutEyes = head.position;
            layoutForward = head.forward.normalized;
            layoutRight = Vector3.Cross(Vector3.up, layoutForward).normalized;
            if (layoutRight.sqrMagnitude < 0.01f) layoutRight = head.right.normalized;
            layoutUp = Vector3.Cross(layoutForward, layoutRight).normalized;
            layoutReady = true;
        }

        private bool Project(Vector3 world, out N.Vector2 point)
        {
            var relative = world - layoutEyes;
            var forward = Vector3.Dot(relative, layoutForward);
            point = default;
            if (forward < 0.05f) return false;
            point = new N.Vector2(Vector3.Dot(relative, layoutRight) / forward,
                Vector3.Dot(relative, layoutUp) / forward);
            return true;
        }

        private Vector3 WorldAt(N.Vector2 point) => layoutEyes
            + (layoutForward + layoutRight * point.X + layoutUp * point.Y).normalized * LabelDistance;

        private void ProtectObjects(SessionView view)
        {
            protectedAreas.Clear();
            protectedWorld.Clear();
            if (room == null) return;
            foreach (var item in view.Items)
            {
                var observation = item.Grounding.ObservationId;
                if (observation == null || !snapshots.TryGetValue(observation, out var snapshot)) continue;
                // Protect both the returned contour and its original box: a partial contour must
                // never free the rest of a grounded object for a label to cover.
                var points = room.PlaceBoundary(item.Grounding, snapshot, out _).ToList();
                if (points.Count > 0) protectedWorld.Add(points.Select(ToNumerics).ToArray());
                if (item.Grounding.Box != null)
                {
                    var box = room.PlaceBoundary(new Grounding { Kind = "box", Box = item.Grounding.Box }, snapshot, out _);
                    protectedWorld.Add(box.Select(ToNumerics).ToArray());
                    points.AddRange(box);
                }
                var projected = new List<N.Vector2>();
                foreach (var point in points)
                    if (Project(point, out var at)) projected.Add(at);
                if (projected.Count > 0)
                    protectedAreas.Add(LabelRect.Envelope(projected));
                else if (AnchorOf(item) is Vector3 anchor && Project(anchor, out var at))
                {
                    protectedAreas.Add(LabelRect.Around(at, new N.Vector2(0.05f, 0.05f)));
                    // A point has unknown extent; retain the same small explicit footprint used
                    // for initial placement rather than inventing a full object reconstruction.
                    var offsets = new[] { new N.Vector2(-0.025f, -0.025f), new N.Vector2(0.025f, -0.025f),
                        new N.Vector2(0.025f, 0.025f), new N.Vector2(-0.025f, 0.025f) };
                    var depth = Vector3.Dot(anchor - layoutEyes, layoutForward);
                    protectedWorld.Add(offsets.Select(offset => ToNumerics(layoutEyes +
                        (layoutForward + layoutRight * (at.X + offset.X) + layoutUp * (at.Y + offset.Y)) * depth)).ToArray());
                }
            }
        }

        private bool BillboardBounds(Vector3 home, Vector2 dimensions, out LabelRect envelope)
        {
            envelope = default;
            var direction = home - layoutEyes;
            var distance = direction.magnitude;
            if (distance < 0.05f) return false;
            direction /= distance;
            var right = Vector3.Cross(Vector3.up, direction).normalized;
            if (right.sqrMagnitude < 0.01f) right = layoutRight;
            var up = Vector3.Cross(direction, right).normalized;
            var half = dimensions * (Layout.ApparentScale(distance) * 0.5f);
            var corners = new List<N.Vector2>(4);
            foreach (var x in new[] { -1f, 1f })
                foreach (var y in new[] { -1f, 1f })
                {
                    if (!Project(home + right * (half.x * x) + up * (half.y * y), out var point)) return false;
                    corners.Add(point);
                }
            envelope = LabelRect.Envelope(corners);
            return true;
        }

        private bool ClearOfObjectsAndLabels(LabelRect candidate, List<LabelRect> occupied, LabelRect bounds)
        {
            if (!bounds.Contains(candidate)) return false;
            return !protectedAreas.Any(area => candidate.Intersects(area, LabelGap))
                && !occupied.Any(area => candidate.Intersects(area, LabelGap));
        }

        private bool TryPlaceElement(Vector2 dimensions, N.Vector2 preferred, List<LabelRect> occupied,
            LabelRect bounds, out Vector3 home, out LabelRect envelope)
        {
            home = default;
            envelope = default;
            var size = new N.Vector2(dimensions.x, dimensions.y);
            for (var attempt = 0; attempt < 8; attempt++)
            {
                if (!SpatialLabelLayout.TryPlace(preferred, size, protectedAreas, occupied,
                    bounds, out var candidate, LabelGap)) return false;
                var world = WorldAt(candidate.Center);
                if (!BillboardBounds(world, dimensions, out var actual)) return false;
                if (ClearOfObjectsAndLabels(actual, occupied, bounds))
                {
                    home = world;
                    envelope = actual;
                    return true;
                }
                // Perspective can make a billboard wider than its local dimensions off-axis.
                // Reserve its complete projected envelope, then search again; never accept an
                // approximate rectangle that clips the protected object or another label.
                var center = candidate.Center;
                size = new N.Vector2(
                    MathF.Max(size.X, 2f * MathF.Max(center.X - actual.MinX, actual.MaxX - center.X)) * 1.05f,
                    MathF.Max(size.Y, 2f * MathF.Max(center.Y - actual.MinY, actual.MaxY - center.Y)) * 1.05f);
            }
            return false;
        }

        private bool ReserveConsole(List<LabelRect> occupied)
        {
            // Over a recording the console keeps its home on it, never hidden; the room's keepouts are the room's.
            if (console != null && KeepPlaced(console)) return true;
            ConsolePlaced = false;
            if (console == null) return false;
            if (turnOpen) return ReserveTurnPlace(console, occupied);
            if (followingConsole)
            {
                if (!FollowFootprintClear(console, console.transform.position))
                {
                    followingConsole = false;
                }
                else
                {
                    console.Place(console.transform.position);
                    ConsolePlaced = true;
                    if (ConsoleBounds(console, out var current)) occupied.Add(current);
                    return true;
                }
            }
            if (TryPlaceElement(console.LayoutSize, ConsoleHome, occupied, ViewBounds, out var home, out var bounds)
                && FollowFootprintClear(console, ConsoleAnchor(home)))
            {
                console.Place(ConsoleAnchor(home));
                if (ConsoleBounds(console, out var actual)) occupied.Add(actual);
                ConsolePlaced = true;
                return true;
            }
            if (TryPlaceElement(console.LayoutSize, ConsoleHome, occupied, Expanded(), out home, out bounds)
                && FollowFootprintClear(console, ConsoleAnchor(home)))
            {
                console.Place(ConsoleAnchor(home));
                if (ConsoleBounds(console, out var actual)) occupied.Add(actual);
                ConsolePlaced = true;
                return true;
            }
            // An extreme envelope may leave no valid forward placement. Do not silently keep
            // stale controls across the subject. The caller can report the lack of room.
            console.ShowControlsOnly(console.transform.position);
            return false;
        }

        // During a turn the console keeps the place it took at the pinch unless the reply's own objects cover it. Then it
        // goes by fade to the nearest clear spot, or with none hides behind the line's fallback strip, also by fade.
        private bool ReserveTurnPlace(ContextConsole controls, List<LabelRect> occupied)
        {
            var place = controls.Destination;
            if (FollowFootprintClear(controls, place))
            {
                if (!controls.Relocating) controls.Place(place);
                ConsolePlaced = true;
                if (ConsoleBoundsAt(controls, place, out var current)) occupied.Add(current);
                return true;
            }
            foreach (var bounds in new[] { ViewBounds, Expanded() })
            {
                if (!TryPlaceElement(controls.LayoutSize, ConsoleHome, occupied, bounds, out var spot, out var envelope)
                    || !FollowFootprintClear(controls, ConsoleAnchor(spot))) continue;
                controls.Relocate(ConsoleAnchor(spot));
                occupied.Add(envelope);
                ConsolePlaced = true;
                return true;
            }
            controls.Relocate(null);
            return false;
        }

        // Controls remain reachable beside a large subject, even if looking toward the edge
        // of the initial view is necessary. Only annotation chips are capped for overflow.
        private LabelRect Expanded()
        {
            var extent = protectedAreas.Count == 0 ? ViewBounds : new LabelRect(
                MathF.Min(ViewBounds.MinX, protectedAreas.Min(area => area.MinX)),
                MathF.Min(ViewBounds.MinY, protectedAreas.Min(area => area.MinY)),
                MathF.Max(ViewBounds.MaxX, protectedAreas.Max(area => area.MaxX)),
                MathF.Max(ViewBounds.MaxY, protectedAreas.Max(area => area.MaxY)));
            return new LabelRect(extent.MinX - 1.2f, extent.MinY - 0.8f, extent.MaxX + 1.2f, extent.MaxY + 0.8f);
        }

        // Layout searches place the entire sheet's center; the interaction anchor is the
        // stable caption above it. Opening actions must not move the speaker/caption.
        private Vector3 ConsoleAnchor(Vector3 center)
            => console == null || head == null ? center : Anchor(head, center, console.LayoutCenterOffset);

        private static Vector3 Anchor(Transform head, Vector3 center, float offset)
        {
            var direction = (center - head.position).normalized;
            var right = Vector3.Cross(Vector3.up, direction).normalized;
            var up = right.sqrMagnitude > 1e-8f ? Vector3.Cross(direction, right).normalized : head.up;
            return center - up * offset;
        }

        private bool ConsoleBounds(ContextConsole controls, out LabelRect bounds)
            => ConsoleBounds(controls, controls.transform.position, controls.transform.right, controls.transform.up, out bounds);

        // Where a fade is taking the console, facing the wearer as it will there.
        private bool ConsoleBoundsAt(ContextConsole controls, Vector3 position, out LabelRect bounds)
        {
            if (!controls.Relocating) return ConsoleBounds(controls, out bounds);
            var direction = (position - head!.position).normalized;
            var right = Vector3.Cross(Vector3.up, direction).normalized;
            if (right.sqrMagnitude < 1e-8f) right = head.right;
            return ConsoleBounds(controls, position, right, Vector3.Cross(direction, right).normalized, out bounds);
        }

        private bool ConsoleBounds(ContextConsole controls, Vector3 position, Vector3 sideways, Vector3 upward, out LabelRect bounds)
        {
            var center = position + upward * controls.LayoutCenterOffset;
            var half = controls.LayoutSize * .5f;
            var right = sideways * half.x;
            var up = upward * half.y;
            var projected = new List<N.Vector2>();
            foreach (var corner in new[] { center - right - up, center + right - up, center + right + up, center - right + up })
            {
                if (!Project(corner, out var point)) { bounds = default; return false; }
                projected.Add(point);
            }
            bounds = LabelRect.Envelope(projected);
            return true;
        }

        public void Focus(Chip? focused)
        {
            FocusItem(focused?.ItemId);
        }

        /// <summary>Hover or explicit reader selection emphasizes identity, never verification.</summary>
        public int? AccentFor(string? id) => id != null && accents.TryGet(id, out var slot) ? slot : (int?)null;

        public void FocusItem(string? itemId)
        {
            var next = itemId != null && groundedItems.Contains(itemId) ? itemId : null;
            if (next == focusedItemId) return;
            focusedItemId = next;
            // Reader focus is an explicit presentation choice. Stable per-frame focus calls
            // never rebuild annotations, and never mutate the evidence or service referent.
            if (renderedView != null) Render(renderedView);
            foreach (var chip in chips.Values)
            {
                chip.Focus(chip.ItemId == focusedItemId);
                chip.SetPeerFocused(focusedItemId != null && chip.ItemId != focusedItemId);
            }
            foreach (var pair in overlays) pair.Value.SetFocus(pair.Key == focusedItemId, focusedItemId != null);
        }

        private void LateUpdate()
        {
            if (head == null) return;
            // Subject outlines keep their angle as the eyes move; chips face the eyes and end their leaders at the outline.
            foreach (var overlay in overlays.Values)
                if (overlay.gameObject.activeSelf) overlay.SetViewer(head.position);
            foreach (var chip in chips.Values)
                if (chip.gameObject.activeSelf) chip.Face(head);
        }

        /// <summary>The commit: every chip gathers into the wrist, and the room is clear again.</summary>
        public void Boop(Transform pocket, Action done)
        {
            if (booping) return;
            StartCoroutine(Gather(pocket, done));
        }

        private IEnumerator Gather(Transform pocket, Action done)
        {
            booping = true;
            foreach (var overlay in overlays.Values) overlay.gameObject.SetActive(false);
            var starts = chips.Values.Where(chip => chip.gameObject.activeSelf)
                .ToDictionary(chip => chip, chip => chip.transform.position);
            const float seconds = 0.6f;
            for (var t = 0f; t < seconds; t += Time.unscaledDeltaTime)
            {
                var k = Mathf.SmoothStep(0f, 1f, t / seconds);
                foreach (var pair in starts)
                {
                    if (pair.Key == null) continue;
                    pair.Key.transform.position = Vector3.Lerp(pair.Value, pocket.position, k);
                    pair.Key.Shrink = 1f - 0.85f * k;
                }
                yield return null;
            }
            Clear();
            booping = false;
            done();
        }

        public void Clear()
        {
            foreach (var chip in chips.Values) { chip.gameObject.SetActive(false); if (Application.isPlaying) Destroy(chip.gameObject); else DestroyImmediate(chip.gameObject); }
            chips.Clear();
            snapshots.Clear();
            protectedAreas.Clear();
            protectedWorld.Clear();
            layoutReady = false;
            // Over a recording Boopy stays where he is, shown.
            if (!OnRecording) ConsolePlaced = false;
            referentPoint = null;
            foreach (var overlay in overlays.Values) { overlay.gameObject.SetActive(false); if (Application.isPlaying) Destroy(overlay.gameObject); else DestroyImmediate(overlay.gameObject); }
            overlays.Clear();
            foreach (var word in words.Values) { word.gameObject.SetActive(false); Discard(word.gameObject); }
            words.Clear();
            foreach (var pin in pins.Values) { pin.gameObject.SetActive(false); Discard(pin.gameObject); }
            pins.Clear(); pointed.Clear();
            accents.Clear(); focusedItemId = null; renderedView = null; renderedSessionId = null; renderedReferentId = null; groundedItems.Clear();
            task = null;
        }

        private static N.Vector3 ToNumerics(Vector3 value) => new N.Vector3(value.x, value.y, value.z);

        // Editor checks render outside play mode, where only DestroyImmediate is allowed.
        private static void Discard(GameObject gone)
        {
            if (Application.isPlaying) Destroy(gone);
            else DestroyImmediate(gone);
        }

    }
}
