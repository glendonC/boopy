#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Boopy.Client;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// The attended subject's look and what Boopy does while it works on it, through BoopyApp with synthetic views
    /// and transport: a soft Ember edge with no dashes or corners, a brighter inner rim and on a mask a low fill; one 0.6 s
    /// sweep from Boopy's side when the outline first appears and when work starts on it; Boopy beside the subject,
    /// never over it or the view center, facing it, with a cone ending at its edge during the sweep; narrowed eyes
    /// and a breathing glow while it thinks; all of it back when the answer lands. Reduced motion keeps Boopy home,
    /// turned to the subject, with no sweep, no cone and a steady glow. A turn without a photo leaves Boopy home with
    /// no sweep or cone. A box with no mask is not filled; a mask is. In batch mode any failure exits non-zero.
    /// </summary>
    public static class SubjectLookValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const float Step = 1f / 30f;

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                HangulFont.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Look();
                Mask();
                Working(reduced: false);
                Working(reduced: true);
                Working(reduced: false, picture: false);
                Debug.Log("Boopy subject look validation passed: soft Ember edge with rounded corners, brighter inner rim, "
                    + "no fill on a box with no mask, a mask filled on its own contour, one sweep from Boopy's side, upright on a mask "
                    + "from level with its middle, Boopy beside the subject facing it with a cone to its edge during the sweep, "
                    + "narrowed eyes and a breathing glow while thinking, home on a turn without a photo, home again when the answer "
                    + "lands, reduced motion still (synthetic).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void Look()
        {
            using var f = new TaskPresentationValidation.Fixture(false);
            f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
            f.Start();
            var overlay = Subject(f);
            var outline = Line(overlay, "Observed boundary");
            Require(outline.enabled && outline.loop && outline.sharedMaterial != Visuals.Dashed && outline.sharedMaterial != Visuals.Solid,
                "The subject's outline is dashed or hard-edged.");
            Require(Near(outline.startColor, SpatialTheme.Ember), "The subject's outline is not Ember: " + outline.startColor);
            var shape = Positions(outline);
            Require(shape.Length > 4 && SharpestTurn(f, shape) < 50f, "The subject's outline has corners: " + SharpestTurn(f, shape).ToString("0") + " degrees.");
            var rim = Line(overlay, "Inner rim");
            Require(rim.enabled && rim.loop && Brightness(rim.startColor) > Brightness(outline.startColor), "The inner rim is missing or not brighter.");
            var polygon = shape.Select(point => Seen(f, point)).ToArray();
            Require(Positions(rim).All(point => Inside(polygon, Seen(f, point))), "The inner rim leaves the outline.");
            // One edge, not two hairlines: the rim lies against the inside of the outer line.
            var touching = (outline.widthMultiplier + rim.widthMultiplier) / 2f + .0005f;
            var apart = Positions(rim).Max(point => NearestOnLoop(shape, point));
            Require(apart <= touching, "The inner rim sits apart from the edge: " + (apart * 1000f).ToString("0.0") + " mm, touching is "
                + (touching * 1000f).ToString("0.0") + " mm.");
            // The outline encloses the subject: every corner of the box the capture placed lies inside it.
            var room = f.Root.GetComponent<RoomCamera>();
            var corners = room.PlaceBoundary(TaskPresentationValidation.Session().Items[0].Grounding, TaskPresentationValidation.Snapshot(), out _);
            Require(corners.Length == 4 && corners.All(corner => Inside(polygon, Seen(f, corner))), "A corner of the subject's box pokes out past its outline.");
            // Close to the subject, not a card around it: the outline stands off the box by about 7 mrad as seen from
            // the eyes, whatever the distance (between 5 and 8.5 at its widest).
            var box = corners.Select(corner => Seen(f, corner)).ToArray();
            var margin = shape.Max(point => Distance(box, Seen(f, point)));
            Require(margin >= .005f && margin <= .0085f, "The outline stands off the subject by " + (margin * 1000f).ToString("0.0") + " mrad, not about 7.");
            // A box with no mask stays approximate: an edge, no fill.
            var fill = overlay.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Proposed contour tint");
            Require(!fill.enabled, "A box with no mask is filled; only a mask fills.");
            // No dashes on any chip: the subject's proposed chip and a live proposed name keep a solid hairline, and
            // proposed stays in their words and tone.
            var frame = TaskPresentationValidation.ActiveChips(f).Single().GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Clipped frame");
            Require(frame.sharedMaterial == Visuals.Solid, "The subject's chip has a dashed border.");
            var words = TaskPresentationValidation.ActiveChips(f).Single().GetComponentsInChildren<TMPro.TextMeshPro>(true).Single(text => text.name == "State").text;
            Require(words.EndsWith("/ unsure") || words.EndsWith("/ proposed"), "The subject's chip no longer says it is proposed: " + words);
            var live = Chip.Create(f.Root.transform, Visuals.Quad());
            live.ShowProposed("Stone");
            Require(live.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == "Clipped frame").sharedMaterial == Visuals.Solid,
                "A live proposed name has a dashed border.");
            var asked = live.GetComponentsInChildren<TMPro.TextMeshPro>(true).Single(text => text.name == "Label").text;
            Require(asked == "Stone?", "A live proposed name no longer asks: " + asked);
            UnityEngine.Object.DestroyImmediate(live.gameObject);
            // The margin follows the eyes, but the subject has not moved: it does not appear again or sweep again.
            var again = overlay.Show(TaskPresentationValidation.Session().Items[0].Grounding, corners, true, true, f.Eyes.position + new Vector3(.4f, 0f, .5f));
            Require(!again, "The outline appeared again when only the eyes moved.");

            // The outline appeared with this turn: one sweep from Boopy's side (the console), then it ends.
            using var g = new TaskPresentationValidation.Fixture(false);
            g.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
            g.Start();
            var appeared = Subject(g);
            var band = Line(appeared, "Scan band");
            Require(appeared.SweepProgress != null, "No sweep when the outline first appeared.");
            appeared.RefreshVisuals(.05f);
            var early = BandSide(g, band);
            appeared.RefreshVisuals(.25f);
            Require(band.enabled && appeared.SweepProgress is float middle && middle > .3f && middle < .7f, "The sweep is not running at 0.3 s.");
            var later = BandSide(g, band);
            // Like the fill, the band of light crosses the subject itself, not the margin out to the edge.
            var crossed = g.Root.GetComponent<RoomCamera>().PlaceBoundary(TaskPresentationValidation.Session().Items[0].Grounding,
                TaskPresentationValidation.Snapshot(), out _).Select(corner => Seen(g, corner)).ToArray();
            Require(Positions(band).All(point => Inside(crossed, Seen(g, point)) || Distance(crossed, Seen(g, point)) < .0005f),
                "The sweep runs past the subject's box.");
            var home = Seen(g, g.Console.transform.position).X;
            Require(Mathf.Abs(early - home) < Mathf.Abs(later - home), "The sweep does not start on Boopy's side.");
            appeared.RefreshVisuals(.4f);
            Require(appeared.SweepProgress == null && !band.enabled, "The sweep did not end after 0.6 s.");
        }

        // A mask (the synthetic stone) is filled low on its own contour, the object and nothing past it. Its outline
        // crowds its points at the rounded top; swept from level with the middle of the subject, the band travels
        // toward that middle and stands upright, not toward the average of the points, which sits high, and slants.
        private static void Mask()
        {
            var root = new GameObject("Synthetic upright sweep");
            try
            {
                var overlay = GroundedOverlay.Create(root.transform, attended: true);
                var stone = TaskPresentationRender.Stone;
                var grounding = new Grounding
                {
                    Kind = "box", ObservationId = TaskPresentationValidation.ObservationId, Box = new Box2 { X0 = 0f, Y0 = 0f, X1 = 1f, Y1 = 1f },
                    Contour = stone.Select(point => new Point2 { X = point.x, Y = point.y }).ToList(),
                    Spatial = new SpatialEvidence { Outcome = "contour", Verification = "proposed" },
                };
                var placed = stone.Select(point => new Vector3(-.3f + point.x * .6f, .37f - point.y * .74f, 2f)).ToArray();
                overlay.Show(grounding, placed, true, true, Vector3.zero);
                var fill = overlay.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Proposed contour tint");
                overlay.RefreshVisuals(1f);
                var block = new MaterialPropertyBlock(); fill.GetPropertyBlock(block);
                var alpha = block.GetColor("_Color").a;
                Require(fill.enabled && alpha > 0f && alpha <= .12f, "A mask's fill is missing or not a low tint: " + alpha.ToString("0.000"));
                var tinted = fill.GetComponent<MeshFilter>().sharedMesh.vertices.Select(vertex => fill.transform.TransformPoint(vertex)).ToArray();
                Require(tinted.Length == placed.Length && tinted.Select((vertex, i) => (vertex - placed[i]).sqrMagnitude < 1e-8f).All(same => same),
                    "A mask's fill is not on its own contour.");
                overlay.Sweep(new Vector3(-.5f, 0f, 2f));
                overlay.RefreshVisuals(.3f);
                var band = Positions(Line(overlay, "Scan band"));
                Require(band.Length == 2, "No sweep across the synthetic mask.");
                var tilt = Mathf.Atan2(Mathf.Abs(band[1].x - band[0].x), Mathf.Abs(band[1].y - band[0].y)) * Mathf.Rad2Deg;
                Require(tilt < 2f, "A sweep from level with the subject's middle slants " + tilt.ToString("0.0") + " degrees.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        // A turn without a photo works on no recorded view: Boopy stays home with no sweep or cone, and only its
        // eyes and glow show that it thinks.
        private static void Working(bool reduced, bool picture = true)
        {
            var mode = reduced ? "Reduced motion: " : !picture ? "Without a photo: " : "";
            var visits = picture && !reduced;
            using var f = new TaskPresentationValidation.Fixture(false);
            if (reduced) { f.Console.SetReducedMotion(true); f.Scene.SetReducedMotion(true); }
            f.Transport.Open.Enqueue(() => TaskPresentationValidation.Reply(HttpStatusCode.OK, TaskPresentationValidation.TaskView()));
            f.Start();
            if (reduced) Require(Subject(f).SweepProgress == null, "Reduced motion: a sweep played when the outline appeared.");
            Advance(f, 1f);
            var companion = (CompanionOrb)Get(f.Console, "companion")!;
            Require(f.Scene.TryGetActiveAnchor(out var anchor), "The synthetic subject has no anchor.");
            var overlay = Subject(f);
            var shape = Positions(Line(overlay, "Observed boundary"));

            var problems = new List<string>();
            f.Transport.OnUtter = () =>
            {
                Expect(problems, f.Console.CompanionVisiting == visits, mode + "Boopy " + (visits ? "did not set out for the subject." : "flew to the subject."));
                var coneSeen = false; var coneEnded = true; var bandSeen = false; var coneBase = true;
                Color? firstGlow = null;
                for (var frame = 0; frame < 60; frame++)
                {
                    Advance(f, Step);
                    var cone = Cone(companion);
                    var band = Line(overlay, "Scan band");
                    bandSeen |= band.enabled;
                    if (cone != null && cone.enabled)
                    {
                        coneSeen = true;
                        coneEnded = !band.enabled ? false : coneEnded;
                        var mesh = cone.GetComponent<MeshFilter>().sharedMesh;
                        var points = mesh.vertices.Select(vertex => cone.transform.TransformPoint(vertex)).ToArray();
                        coneBase &= shape.All(edge => points.Any(point => (point - edge).sqrMagnitude < 4e-6f));
                    }
                    if (frame == 30) firstGlow = Glow(companion);
                }
                var laterGlow = Glow(companion);
                Expect(problems, bandSeen == visits, mode + (visits ? "no sweep when work started." : "a sweep played."));
                Expect(problems, coneSeen == visits, mode + (visits ? "no cone during the sweep." : "a cone was cast."));
                Expect(problems, !visits || (coneBase && coneEnded), mode + "the cone does not end at the subject's edge, or outlasts the sweep.");
                Expect(problems, Cone(companion) == null || !Cone(companion)!.enabled, mode + "the cone stayed after the sweep.");
                var at = Seen(f, companion.transform.position);
                var polygon = shape.Select(point => Seen(f, point)).ToArray();
                var radius = .06f * f.Console.ComfortScale / Vector3.Distance(f.Eyes.position, companion.transform.position);
                if (visits)
                {
                    Expect(problems, !Inside(polygon, at) && Distance(polygon, at) >= radius, "Boopy is over the subject.");
                    Expect(problems, Mathf.Abs(at.X) >= .15f || Mathf.Abs(at.Y) >= .15f, "Boopy is in the view center: " + at);
                }
                else Expect(problems, (companion.transform.localPosition - Home(f)).sqrMagnitude < 1e-6f, mode + "Boopy left home.");
                var facing = Vector3.Angle(-companion.transform.forward, anchor - companion.transform.position);
                if (picture) Expect(problems, facing < 20f, mode + "Boopy does not face the subject (" + facing.ToString("0") + " degrees).");
                var lens = companion.GetComponentsInChildren<MeshRenderer>(true).First(renderer => renderer.name == "Dark expressive eye");
                Expect(problems, lens.transform.localScale.y <= .6f * .01648f, mode + "Boopy's eyes are not narrowed while it thinks.");
                var glow = laterGlow;
                Expect(problems, Distance(glow, SpatialTheme.Ember) < Distance(SpatialTheme.Porcelain, SpatialTheme.Ember),
                    mode + "Boopy does not glow toward Ember while it thinks.");
                Expect(problems, reduced ? Distance(firstGlow!.Value, glow) < .01f : Distance(firstGlow!.Value, glow) > .02f,
                    mode + (reduced ? "the glow breathes under reduced motion." : "the glow does not breathe."));
            };
            Set(f.App, "pending", TaskPresentationValidation.Snapshot()); Set(f.App, "pendingEvidence", new EvidenceTurn(!picture));
            ((Task)typeof(BoopyApp).GetMethod("Send", Flags)!.Invoke(f.App, new object[] { SpeechValidation.SyntheticWav() })!).GetAwaiter().GetResult();
            f.Transport.OnUtter = null;
            Require(f.Transport.Count("/v1/sessions/" + TaskPresentationValidation.SessionId + "/utterances") == 1, mode + "The second turn never reached the Mac.");
            Require(problems.Count == 0, string.Join(" ", problems));

            // The answer landed: Boopy is home, plain, eyes open, with no cone.
            Advance(f, 1f);
            Require(!f.Console.CompanionVisiting && (companion.transform.localPosition - Home(f)).sqrMagnitude < 1e-6f, mode + "Boopy did not come home when the answer landed.");
            Require(Cone(companion) == null || !Cone(companion)!.enabled, mode + "The cone stayed after the answer.");
            Require(Distance(Glow(companion), SpatialTheme.Porcelain) < .02f, mode + "Boopy still glows after the answer.");
            var open = companion.GetComponentsInChildren<MeshRenderer>(true).First(renderer => renderer.name == "Dark expressive eye");
            Require(open.transform.localScale.y > .75f * .01648f, mode + "Boopy's eyes stayed narrowed after the answer.");
        }

        private static void Advance(TaskPresentationValidation.Fixture f, float seconds)
        {
            for (var elapsed = 0f; elapsed < seconds - 1e-4f; elapsed += Step)
            {
                foreach (var overlay in f.Scene.GetComponentsInChildren<GroundedOverlay>()) overlay.RefreshVisuals(Step);
                f.Console.RefreshVisuals(Step); f.Strip.RefreshVisuals(Step);
            }
        }

        // Boopy's place beside the console, which follows the console's own layout.
        private static Vector3 Home(TaskPresentationValidation.Fixture f) => (Vector3)Get(f.Console, "companionHome")!;

        private static GroundedOverlay Subject(TaskPresentationValidation.Fixture f) =>
            f.Scene.GetComponentsInChildren<GroundedOverlay>().Single(overlay => overlay.gameObject.activeInHierarchy);
        private static LineRenderer Line(GroundedOverlay overlay, string name) =>
            overlay.GetComponentsInChildren<LineRenderer>(true).Single(line => line.name == name);
        private static MeshRenderer? Cone(CompanionOrb companion) =>
            companion.GetComponentsInChildren<MeshRenderer>(true).SingleOrDefault(renderer => renderer.name == "Attention cone");
        private static Color Glow(CompanionOrb companion) =>
            companion.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Porcelain body").sharedMaterial.GetColor("_BaseColor");
        private static Vector3[] Positions(LineRenderer line) { var points = new Vector3[line.positionCount]; line.GetPositions(points); return points; }

        // Where the band sits across the view, as seen from the eyes.
        private static float BandSide(TaskPresentationValidation.Fixture f, LineRenderer band) =>
            Positions(band).Select(point => Seen(f, point).X).DefaultIfEmpty(float.NaN).Average();

        private static N.Vector2 Seen(TaskPresentationValidation.Fixture f, Vector3 point)
        {
            var local = f.Eyes.InverseTransformPoint(point);
            return new N.Vector2(local.x / local.z, local.y / local.z);
        }

        private static float SharpestTurn(TaskPresentationValidation.Fixture f, Vector3[] shape)
        {
            var seen = shape.Select(point => Seen(f, point)).ToArray();
            var sharpest = 0f;
            for (var index = 0; index < seen.Length; index++)
            {
                var a = seen[(index + seen.Length - 1) % seen.Length]; var b = seen[index]; var c = seen[(index + 1) % seen.Length];
                var u = b - a; var v = c - b;
                if (u.LengthSquared() < 1e-12f || v.LengthSquared() < 1e-12f) continue;
                var angle = MathF.Acos(Math.Clamp(N.Vector2.Dot(N.Vector2.Normalize(u), N.Vector2.Normalize(v)), -1f, 1f)) * Mathf.Rad2Deg;
                sharpest = Mathf.Max(sharpest, angle);
            }
            return sharpest;
        }

        // How far a point lies from a closed loop of segments, in meters.
        private static float NearestOnLoop(Vector3[] loop, Vector3 point)
        {
            var nearest = float.PositiveInfinity;
            for (var index = 0; index < loop.Length; index++)
            {
                var a = loop[index]; var b = loop[(index + 1) % loop.Length];
                var along = Mathf.Clamp01(Vector3.Dot(point - a, b - a) / Mathf.Max(1e-12f, (b - a).sqrMagnitude));
                nearest = Mathf.Min(nearest, Vector3.Distance(point, a + (b - a) * along));
            }
            return nearest;
        }

        private static bool Inside(N.Vector2[] polygon, N.Vector2 at)
        {
            var inside = false;
            for (int index = 0, previous = polygon.Length - 1; index < polygon.Length; previous = index++)
            {
                var a = polygon[previous]; var b = polygon[index];
                if ((a.Y > at.Y) != (b.Y > at.Y) && at.X < (b.X - a.X) * (at.Y - a.Y) / (b.Y - a.Y) + a.X) inside = !inside;
            }
            return inside;
        }

        private static float Distance(N.Vector2[] polygon, N.Vector2 at)
        {
            var nearest = float.PositiveInfinity;
            for (int index = 0, previous = polygon.Length - 1; index < polygon.Length; previous = index++)
            {
                var a = polygon[previous]; var b = polygon[index];
                var along = Math.Clamp(N.Vector2.Dot(at - a, b - a) / Math.Max(1e-12f, (b - a).LengthSquared()), 0f, 1f);
                nearest = Math.Min(nearest, N.Vector2.Distance(at, a + (b - a) * along));
            }
            return nearest;
        }

        private static bool Near(Color a, Color b) => Distance(a, b) < .03f;
        private static float Distance(Color a, Color b) => Mathf.Sqrt((a.r - b.r) * (a.r - b.r) + (a.g - b.g) * (a.g - b.g) + (a.b - b.b) * (a.b - b.b));
        private static float Brightness(Color color) => (color.r + color.g + color.b) * color.a;

        private static void Expect(List<string> problems, bool condition, string message) { if (!condition) problems.Add(message); }
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Set(object target, string name, object? value) => target.GetType().GetField(name, Flags)!.SetValue(target, value);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
