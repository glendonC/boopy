#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Boopy.Client;
using TMPro;
using UnityEditor.SceneManagement;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest.Editor
{
    public static class AuditLiveSceneValidation
    {
        public static void ValidateAll()
        {
            ValidateIndependent();
            LiveSceneMechanicsValidation.ValidateAll();
            LiveSceneMechanicsValidation.ValidateVisibility();
            Debug.Log("AUDIT native03 exact source and independent admission/cache checks passed.");
        }

        public static void ValidateIndependent()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Independent synthetic live admission audit");
            try
            {
                var head = new GameObject("Synthetic audit eye").transform; head.SetParent(root.transform, false);
                var room = root.AddComponent<RoomCamera>();
                var hud = LiveSceneHud.Create(root.transform, head, room);
                var changes = new[] { "width", "height", "time", "pixels", "eye", "position", "rotation",
                    "focal", "principal", "sensor", "columns", "rows", "depth", "null-camera", "null-depth" };
                foreach (var change in changes)
                {
                    var fixture = Fixture();
                    switch (change)
                    {
                        case "width": fixture.Request.Frame.Width++; break;
                        case "height": fixture.Request.Frame.Height++; break;
                        case "time": fixture.Request.Frame.CapturedAt = fixture.Snapshot.CapturedAt.AddSeconds(1).ToString("o"); break;
                        case "pixels": fixture.Request.Frame.Jpeg = "Ag=="; break;
                        case "eye": fixture.Request.Frame.Camera!.Eye = "right"; break;
                        case "position": fixture.Request.Frame.Camera!.Pose.Position[0] += .1f; break;
                        case "rotation": fixture.Request.Frame.Camera!.Pose.Rotation[0] += .1f; break;
                        case "focal": fixture.Request.Frame.Camera!.FocalLength[0] += 1f; break;
                        case "principal": fixture.Request.Frame.Camera!.PrincipalPoint[0] += 1f; break;
                        case "sensor": fixture.Request.Frame.Camera!.SensorResolution[0]++; break;
                        case "columns": fixture.Request.Frame.Depth!.Columns++; break;
                        case "rows": fixture.Request.Frame.Depth!.Rows++; break;
                        case "depth": fixture.Request.Frame.Depth!.Meters[0] = 1.9f; break;
                        case "null-camera": fixture.Request.Frame.Camera = null; break;
                        case "null-depth": fixture.Request.Frame.Depth = null; break;
                    }
                    Require(!hud.Show(fixture.Result, fixture.Request, fixture.Snapshot, 11f), "Capture metadata mismatch admitted: " + change);
                }
                var valid = Fixture();
                Require(hud.Show(valid.Result, valid.Request, valid.Snapshot, 11f), "Independent positive source did not admit.");
                var grounding = valid.Result.Objects[0].GroundingFor(valid.Result);
                var boundary = room.PlaceBoundary(grounding, valid.Snapshot, out _);
                var at = boundary.Aggregate(Vector3.zero, (sum, point) => sum + point) / boundary.Length;
                var ray = new Ray(head.position, at - head.position);
                hud.SetAttentionRays(ray, null); hud.RefreshAttention(11f, Array.Empty<LabelRect>(), new LabelRect(-.12f, -.09f, .12f, .09f), 1f);
                var label = VisibleLabels(hud).Single(); var target = hud.CurrentTarget;
                Require(target != null && target.ObjectIndex == 0 && target.EventId == "audit-native-event", "Independent source identity was lost.");
                var before = hud.GetComponentsInChildren<GroundedOverlay>().SelectMany(overlay =>
                {
                    var line = overlay.GetComponentInChildren<LineRenderer>(); var points = new Vector3[line.positionCount];
                    line.GetPositions(points); return points;
                }).ToArray();
                // Mutate every original holder after admission. The frame loop must use its cache.
                valid.Result.EventId = "rewritten"; valid.Result.Objects[0].Label = "rewritten";
                valid.Result.Objects[0].Contour.Clear(); valid.Result.Objects.Clear();
                valid.Snapshot.Jpeg[0] = 2; valid.Snapshot.Depth.Meters[0] = 5f;
                valid.Snapshot.Camera.FocalLength[0] = 5000f;
                valid.Request.Frame.Jpeg = "Ag=="; valid.Request.Frame.Camera!.FocalLength[0] = 1f;
                hud.RefreshAttention(11.2f, Array.Empty<LabelRect>(), new LabelRect(-.12f, -.09f, .12f, .09f), 1f);
                var after = hud.GetComponentsInChildren<GroundedOverlay>().SelectMany(overlay =>
                {
                    var line = overlay.GetComponentInChildren<LineRenderer>(); var points = new Vector3[line.positionCount];
                    line.GetPositions(points); return points;
                }).ToArray();
                Require(before.SequenceEqual(after), "Original mutable source changed cached placed geometry.");
                Require(ReferenceEquals(target, hud.CurrentTarget) && VisibleLabels(hud).Single().GetComponentsInChildren<TextMeshPro>()
                    .Single(text => text.gameObject.activeInHierarchy).text == "Audit synthetic?", "Original mutable source rewrote current evidence.");
                hud.SetAttentionRays(new Ray(head.position, label.Home - head.position), null);
                hud.RefreshAttention(13f, Array.Empty<LabelRect>(), new LabelRect(-.12f, -.09f, .12f, .09f), 1f);
                Require(hud.HasPresentationFocus && hud.CurrentTarget?.SourceTime == 10f, "Own-label focus changed inclusive original age.");
                hud.RefreshAttention(13.001f, Array.Empty<LabelRect>(), new LabelRect(-.12f, -.09f, .12f, .09f), 1f);
                Require(hud.VisibleObjects == 0 && !VisibleLabels(hud).Any() && hud.CurrentTarget == null && !hud.HasPresentationFocus,
                    "Mutated original holders renewed source age or retained expired label.");
                Debug.Log("AUDIT native independent checks passed: 15 capture mismatches, admitted-holder mutation, exact event/index/name, original inclusive3s hold/expiry.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private sealed class Synthetic
        {
            public Snapshot Snapshot = null!;
            public SceneObservationRequest Request = null!;
            public SceneObservation Result = null!;
        }

        private static Synthetic Fixture()
        {
            var camera = new CameraInfo { Eye = "left",
                Pose = new Pose3 { Position = new float[3], Rotation = new[] { 0f, 0f, 0f, 1f } },
                FocalLength = new[] { 40f, 40f }, PrincipalPoint = new[] { 40f, 40f }, SensorResolution = new[] { 80, 80 } };
            var snapshot = new Snapshot(new byte[] { 1 }, 80, 80,
                new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), new Pose(Vector3.zero, Quaternion.identity),
                new DepthGrid { Columns = 1, Rows = 1, Meters = new float?[] { 1.8f } }, camera, 10f);
            var frame = snapshot.ToFrame();
            frame.Camera = new CameraInfo { Eye = camera.Eye,
                Pose = new Pose3 { Position = camera.Pose.Position.ToArray(), Rotation = camera.Pose.Rotation.ToArray() },
                FocalLength = camera.FocalLength.ToArray(), PrincipalPoint = camera.PrincipalPoint.ToArray(), SensorResolution = camera.SensorResolution.ToArray() };
            frame.Depth = new DepthGrid { Columns = snapshot.Depth.Columns, Rows = snapshot.Depth.Rows, Meters = snapshot.Depth.Meters.ToArray() };
            var request = new SceneObservationRequest { StreamId = "11111111-1111-4111-8111-111111111111",
                FrameId = "22222222-2222-4222-8222-222222222222", Sequence = 1, Frame = frame };
            var box = new Box2 { X0 = .15f, X1 = .35f, Y0 = .35f, Y1 = .65f };
            var result = new SceneObservation { StreamId = request.StreamId, FrameId = request.FrameId, Sequence = request.Sequence,
                CapturedAt = frame.CapturedAt, FrameSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
                EventId = "audit-native-event", Provider = "audit-fixture", Model = "synthetic", Verification = "proposed",
                Objects = new List<SceneObject> { new SceneObject { Label = "Audit synthetic", Confidence = .2f,
                    MaskConfidence = .3f, MaskPixels = 100, MaskSha256 = new string('b', 64), Box = box,
                    Contour = Geometry.Corners(box).Select(point => new Point2 { X = point.X, Y = point.Y }).ToList() } } };
            return new Synthetic { Snapshot = snapshot, Request = request, Result = result };
        }
        private static IEnumerable<Chip> VisibleLabels(LiveSceneHud hud) => hud.GetComponentsInChildren<Chip>(true).Where(chip => chip.gameObject.activeInHierarchy);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
