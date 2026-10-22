#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
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
        public void Remember(string observationId, Snapshot snapshot) => snapshots[observationId] = snapshot;

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

        /// <summary>The assistant follows the wearer; evidence keeps its original room position.</summary>
        public bool MoveConsole(ContextConsole controls, Vector3 position)
        {
            console = controls;
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
        // focus and correction, never the item's own label or verification.
        private Item Shown(Item item)
        {
            var annotation = task?.ChipItem();
            if (annotation == null) return item;
            annotation.Id = item.Id;
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
            foreach (var gone in chips.Keys.Where(id => worldItems.All(item => item.Id != id)).ToList())
            {
                chips[gone].gameObject.SetActive(false);
                Discard(chips[gone].gameObject);
                chips.Remove(gone);
            }
            var referent = worldItems.FirstOrDefault();
            referentPoint = referent == null ? null : AnchorOf(referent);
            DrawOutlines(worldItems, view.ReferentId);
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
            var overflow = view.Items.Count(item => item.Id != view.IntentId) - worldItems.Count;
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

        /// <summary>The available contour, or box, with each point placed from its own coarse depth sample.</summary>
        private void DrawOutlines(List<Item> worldItems, string? referentId)
        {
            if (room == null) return;
            var items = worldItems
                .Where(item => Geometry.Outline(item.Grounding).Length >= 3 &&
                    item.Grounding.ObservationId != null && snapshots.ContainsKey(item.Grounding.ObservationId)).ToList();
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
                { overlay = GroundedOverlay.Create(transform); overlay.SetReducedMotion(reducedMotion); overlays[item.Id] = overlay; }
                var positions = room.PlaceBoundary(item.Grounding, snapshot, out var capturedDepth);
                if (accents.TryGet(item.Id, out var slot)) overlay.SetIdentityAccent(slot);
                overlay.SetFocus(item.Id == focusedItemId, focusedItemId != null);
                overlay.Show(item.Grounding, positions, capturedDepth, item.Id == referentId);
            }
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
    }
}
