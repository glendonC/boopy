#nullable enable
using System;
using System.Collections.Generic;
using Boopy.Client;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// A box with no mask is placed at its subject's depth: all four corners on one plane facing the capture
    /// through the point the chip's anchor uses, never on whatever lies behind the subject. A mask keeps its
    /// own contour samples. Synthetic depth only. In batch mode any failure exits non-zero.
    /// </summary>
    public static class BoxDepthValidation
    {
        public static void Run()
        {
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var room = new GameObject("Synthetic room").AddComponent<RoomCamera>();
                try
                {
                    // A 20 x 20 depth grid: the subject at 1 m under the box's center, the background at 3 m around it.
                    // The box's corners sample only background cells; most cells inside the box are background too.
                    var meters = new float?[20 * 20];
                    for (var row = 0; row < 20; row++)
                        for (var column = 0; column < 20; column++)
                            meters[row * 20 + column] = (column == 7 || column == 8) && (row == 9 || row == 10) ? 1f : 3f;
                    var snapshot = new Snapshot(new byte[] { 255, 216, 255, 217 }, 80, 80, new DateTime(1970, 1, 1, 12, 0, 0, DateTimeKind.Utc),
                        new Pose(Vector3.zero, Quaternion.identity), new DepthGrid { Columns = 20, Rows = 20, Meters = meters },
                        new CameraInfo { FocalLength = new float[] { 40, 40 }, PrincipalPoint = new float[] { 40, 40 }, SensorResolution = new[] { 80, 80 } });
                    var box = new Box2 { X0 = .34f, Y0 = .42f, X1 = .49f, Y1 = .605f };
                    var grounding = new Grounding { Kind = "box", ObservationId = "synthetic-observation", Box = box };

                    var anchor = room.Place(Geometry.Center(box), snapshot);
                    Require(Mathf.Abs(Vector3.Distance(snapshot.Pose.position, anchor) - 1f) < .01f, "The synthetic anchor is not on the subject at 1 m.");
                    var corners = room.PlaceBoundary(grounding, snapshot, out var captured);
                    Require(corners.Length == 4 && captured, "The box was not placed from captured depth.");
                    var facing = (anchor - snapshot.Pose.position).normalized;
                    foreach (var corner in corners)
                    {
                        var off = Vector3.Dot(corner - anchor, facing);
                        Require(Mathf.Abs(off) < .002f, "A box corner is " + off.ToString("0.000") + " m off the subject's depth.");
                    }

                    // A mask over background only, on the same box: its samples stay at 3 m and do not sit on the center plane.
                    var mask = new Grounding
                    {
                        Kind = "box", ObservationId = "synthetic-observation", Box = box,
                        Spatial = new SpatialEvidence { Outcome = "contour" },
                        Contour = new List<Point2>
                        {
                            new Point2 { X = .05f, Y = .05f },
                            new Point2 { X = .16f, Y = .05f },
                            new Point2 { X = .10f, Y = .16f },
                        },
                    };
                    var contour = room.PlaceBoundary(mask, snapshot, out var maskCaptured);
                    Require(contour.Length == 3 && maskCaptured, "The mask was not placed from its own captured depth.");
                    foreach (var corner in contour)
                    {
                        var off = Vector3.Dot(corner - anchor, facing);
                        Require(Mathf.Abs(off) > .5f, "A mask corner sat on the subject's center plane.");
                        Require(Vector3.Distance(snapshot.Pose.position, corner) > 2.2f, "A mask corner was pulled forward onto the subject.");
                    }
                    Debug.Log("Boopy box depth validation passed: every corner of a box with no mask lies on the subject's plane, "
                        + "through the anchor and facing the capture, with background depth around it, and a mask keeps its own samples (synthetic).");
                }
                finally { UnityEngine.Object.DestroyImmediate(room.gameObject); }
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
        }

        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
