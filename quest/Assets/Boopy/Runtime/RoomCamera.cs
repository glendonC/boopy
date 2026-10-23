#nullable enable
using System;
using Boopy.Client;
using Meta.XR;
using UnityEngine;
using N = System.Numerics;

namespace Boopy.Quest
{
    /// <summary>One captured frame: the JPEG the service sees, and what it takes to map its pixels back into the room.</summary>
    public sealed class Snapshot
    {
        public Snapshot(byte[] jpeg, int width, int height, DateTime capturedAt, Pose pose, DepthGrid depth, CameraInfo camera, float? sourceTime = null)
        {
            Jpeg = jpeg;
            Width = width;
            Height = height;
            CapturedAt = capturedAt;
            Pose = pose;
            Depth = depth;
            Camera = camera;
            SourceTime = sourceTime;
        }

        public byte[] Jpeg { get; }
        public int Width { get; }
        public int Height { get; }
        public DateTime CapturedAt { get; }
        /// <summary>Local monotonic source moment, retained only in memory for live-view expiry.</summary>
        public float? SourceTime { get; }

        /// <summary>The camera's world pose at the frame's own timestamp.</summary>
        public Pose Pose { get; }

        public DepthGrid Depth { get; }
        public CameraInfo Camera { get; }

        public FrameData ToFrame() => new FrameData
        {
            Jpeg = Convert.ToBase64String(Jpeg),
            Width = Width,
            Height = Height,
            CapturedAt = CapturedAt.ToUniversalTime().ToString("o"),
            Camera = Camera,
            Depth = Depth,
        };
    }

    /// <summary>
    /// The passthrough camera and the room's depth. MRUK's PassthroughCameraAccess gives frames and
    /// the camera pose at each frame's timestamp. Its ray and projection methods take a cached pose,
    /// so a frame interpreted seconds later still maps onto the right place.
    /// The camera's viewport has its origin at the bottom-left; the service's images at the top-left.
    /// </summary>
    public sealed class RoomCamera : MonoBehaviour
    {
        public const int GridColumns = 16;
        public const int GridRows = 12;
        private const float MaxDepth = 6f;

        private PassthroughCameraAccess? access;
        private EnvironmentRaycastManager? raycaster;
        private Texture2D? texture;

        public bool Ready => access != null && access.IsPlaying;

        public static bool Supported => PassthroughCameraAccess.IsSupported;

        private void Awake()
        {
            raycaster = gameObject.AddComponent<EnvironmentRaycastManager>();
            var camera = new GameObject("Passthrough camera");
            camera.transform.SetParent(transform, false);
            access = camera.AddComponent<PassthroughCameraAccess>();
            access.CameraPosition = PassthroughCameraAccess.CameraPositionType.Left;
            access.RequestedResolution = new Vector2Int(1280, 960);
        }

        /// <summary>Where a ray meets the room, from live depth; false outside the depth camera's view.</summary>
        public bool TryHit(Ray ray, float maxDistance, out Vector3 point, out Vector3 normal)
        {
            point = default;
            normal = default;
            if (raycaster == null || !EnvironmentRaycastManager.IsSupported) return false;
            if (!raycaster.Raycast(ray, out var hit, maxDistance)) return false;
            point = hit.point;
            normal = hit.normal;
            return true;
        }

        /// <summary>The latest frame with its pose and a depth sample, or null while the camera is not running.</summary>
        public Snapshot? Capture()
        {
            if (access == null || !access.IsPlaying) return null;
            var capturedAt = access.Timestamp;
            if (!CameraFrameTime.TrySourceTime(capturedAt, DateTime.UtcNow, Time.unscaledTime, out var sourceTime)) return null;
            var pose = access.GetCameraPose();
            var size = access.CurrentResolution;
            var colors = access.GetColors();
            if (texture == null || texture.width != size.x || texture.height != size.y)
            {
                texture = new Texture2D(size.x, size.y, TextureFormat.RGBA32, false);
            }
            texture.SetPixelData(colors, 0);
            texture.Apply(false, false);
            var jpeg = texture.EncodeToJPG(85);
            var intrinsics = access.Intrinsics;
            var camera = new CameraInfo
            {
                Eye = "left",
                Pose = new Pose3
                {
                    Position = new[] { pose.position.x, pose.position.y, pose.position.z },
                    Rotation = new[] { pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w },
                },
                FocalLength = new[] { intrinsics.FocalLength.x, intrinsics.FocalLength.y },
                PrincipalPoint = new[] { intrinsics.PrincipalPoint.x, intrinsics.PrincipalPoint.y },
                SensorResolution = new[] { intrinsics.SensorResolution.x, intrinsics.SensorResolution.y },
            };
            return new Snapshot(jpeg, size.x, size.y, capturedAt, pose, SampleDepth(pose), camera, sourceTime);
        }

        /// <summary>Distances along rays through a grid over the frame, so items can be placed after the head moves.</summary>
        private DepthGrid SampleDepth(Pose pose)
        {
            var meters = new float?[GridColumns * GridRows];
            var index = 0;
            foreach (var center in Geometry.CellCenters(GridColumns, GridRows))
            {
                var ray = RayThrough(center, pose);
                meters[index++] = TryHit(ray, MaxDepth, out var point, out _) ? Vector3.Distance(ray.origin, point) : (float?)null;
            }
            return new DepthGrid { Columns = GridColumns, Rows = GridRows, Meters = meters };
        }

        /// <summary>The ray through an image point (origin top-left) from the camera at a past pose.</summary>
        public Ray RayThrough(N.Vector2 image, Pose pose)
        {
            if (access == null || !access.IsPlaying) return new Ray(pose.position, pose.forward);
            var viewport = Geometry.ToViewport(image.X, image.Y);
            return access.ViewportPointToRay(new Vector2(viewport.X, viewport.Y), pose);
        }

        /// <summary>Where a world point falls in a frame (origin top-left), or null when it is outside it or behind the camera.</summary>
        public Point2? ToImage(Vector3 world, Pose pose)
        {
            if (access == null || !access.IsPlaying) return null;
            var local = Quaternion.Inverse(pose.rotation) * (world - pose.position);
            if (local.z < 0.05f) return null;
            var viewport = access.WorldToViewportPoint(world, pose);
            if (viewport.x < 0f || viewport.x > 1f || viewport.y < 0f || viewport.y > 1f) return null;
            return Geometry.FromViewport(new N.Vector2(viewport.x, viewport.y));
        }

        /// <summary>Where an image point lies in the room: depth from the snapshot, else live depth, else a fallback distance.</summary>
        public Vector3 Place(N.Vector2 image, Snapshot snapshot, float fallback = 1f)
        {
            var ray = SnapshotRay(image, snapshot);
            var meters = Geometry.SampleDepth(snapshot.Depth, image);
            if (meters != null) return ray.origin + ray.direction * meters.Value;
            if (TryHit(ray, MaxDepth, out var point, out _)) return point;
            return ray.origin + ray.direction * fallback;
        }

        /// <summary>Captured intrinsics keep a delayed answer valid even if the camera stopped.</summary>
        private Ray SnapshotRay(N.Vector2 image, Snapshot snapshot)
        {
            if (SurfaceGeometry.CameraRay(image, snapshot.Width, snapshot.Height, snapshot.Camera, out var local))
                return new Ray(snapshot.Pose.position, snapshot.Pose.rotation * new Vector3(local.X, local.Y, local.Z));
            return RayThrough(image, snapshot.Pose);
        }

        /// <summary>
        /// Place a boundary from captured depth. A box with no mask sits at its subject's depth: one plane
        /// facing the capture through the point the chip's anchor uses. A mask contour keeps its own samples:
        /// a distributed, strongly supported plane can stabilize a slanted flat surface; otherwise retain
        /// individual captured samples. Missing depth stays approximate and never receives a surface fill.
        /// </summary>
        public Vector3[] PlaceBoundary(Grounding grounding, Snapshot snapshot, out bool capturedDepth)
        {
            var boundary = Geometry.Outline(grounding);
            capturedDepth = false;
            if (boundary.Length < 3) return Array.Empty<Vector3>();
            if (grounding.Box != null && !Geometry.TryContour(grounding, out _))
            {
                // A box is the subject's extent, not a surface: its corners would sample, and a fitted plane
                // would include, whatever lies behind the subject.
                var center = Geometry.Center(grounding.Box);
                var anchor = Place(center, snapshot);
                var facing = new Plane((snapshot.Pose.position - anchor).normalized, anchor);
                var meters = Geometry.SampleDepth(snapshot.Depth, center);
                capturedDepth = meters != null && meters >= 0.05f && meters <= MaxDepth;
                var placed = new Vector3[boundary.Length];
                for (var i = 0; i < boundary.Length; i++)
                {
                    var ray = SnapshotRay(boundary[i], snapshot);
                    placed[i] = facing.Raycast(ray, out var enter) ? ray.GetPoint(enter) : anchor;
                }
                return placed;
            }
            var samples = new System.Collections.Generic.List<N.Vector3>();
            var index = 0;
            foreach (var cell in Geometry.CellCenters(snapshot.Depth.Columns, snapshot.Depth.Rows))
            {
                if (index >= snapshot.Depth.Meters.Length) break;
                var meters = snapshot.Depth.Meters[index++];
                if (meters == null || float.IsNaN(meters.Value) || float.IsInfinity(meters.Value)
                    || meters < 0.05f || meters > MaxDepth || !SurfaceGeometry.Contains(boundary, cell)) continue;
                var ray = SnapshotRay(cell, snapshot);
                var point = ray.origin + ray.direction * meters.Value;
                samples.Add(new N.Vector3(point.x, point.y, point.z));
            }
            var planar = SurfaceGeometry.TryFitPlane(samples, out var plane);
            var result = new Vector3[boundary.Length];
            var complete = true;
            for (var i = 0; i < boundary.Length; i++)
            {
                var ray = SnapshotRay(boundary[i], snapshot);
                if (planar && plane.Intersect(new N.Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
                    new N.Vector3(ray.direction.x, ray.direction.y, ray.direction.z), out var onPlane))
                {
                    result[i] = new Vector3(onPlane.X, onPlane.Y, onPlane.Z);
                    continue;
                }
                var meters = Geometry.SampleDepth(snapshot.Depth, boundary[i]);
                var known = meters != null && meters >= 0.05f && meters <= MaxDepth;
                complete &= known;
                result[i] = ray.origin + ray.direction * (known ? meters!.Value : 1f);
            }
            capturedDepth = complete;
            return result;
        }
    }
}
