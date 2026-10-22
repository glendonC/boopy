#nullable enable
using System.Collections.Generic;
using UnityEngine;

namespace Boopy.Quest
{
    public enum PassthroughState
    {
        Off,
        Starting,
        Running,
        Unavailable,
    }

    /// <summary>
    /// The room behind everything: the Meta XR Core SDK's passthrough, started through
    /// <see cref="OVRManager.isInsightPassthroughEnabled"/> and drawn by an <see cref="OVRPassthroughLayer"/>
    /// underlay, with the rig's cameras cleared to transparent black so the room shows wherever
    /// nothing is drawn.
    /// </summary>
    public sealed class PassthroughView
    {
        private const float StartSeconds = 6f;

        private readonly GameObject host;
        private readonly List<(Camera Camera, CameraClearFlags Flags, Color Background)> cleared =
            new List<(Camera, CameraClearFlags, Color)>();

        private OVRPassthroughLayer? layer;
        private float startedAt;

        public PassthroughView(GameObject host)
        {
            this.host = host;
        }

        public PassthroughState State { get; private set; } = PassthroughState.Off;

        public string? Problem { get; private set; }

        public void Start(float now)
        {
            if (State != PassthroughState.Off) return;
            var manager = OVRManager.instance;
            if (manager == null)
            {
                MarkUnavailable("the scene has no OVRManager");
                return;
            }
            if (!OVRManager.IsInsightPassthroughSupported())
            {
                MarkUnavailable("this headset does not support it");
                return;
            }
            manager.isInsightPassthroughEnabled = true;
            if (layer == null) layer = host.AddComponent<OVRPassthroughLayer>();
            layer.hidden = false;
            layer.enabled = true;
            ClearCameras();
            startedAt = now;
            State = PassthroughState.Starting;
        }

        public PassthroughState Poll(float now)
        {
            switch (State)
            {
                case PassthroughState.Starting when OVRManager.IsInsightPassthroughInitialized():
                    State = PassthroughState.Running;
                    break;
                case PassthroughState.Starting when OVRManager.HasInsightPassthroughInitFailed():
                    MarkUnavailable("it failed to start");
                    break;
                case PassthroughState.Starting when now - startedAt > StartSeconds:
                    MarkUnavailable($"it did not start within {StartSeconds} seconds");
                    break;
            }
            return State;
        }

        private void MarkUnavailable(string problem)
        {
            Problem = problem;
            State = PassthroughState.Unavailable;
        }

        private void ClearCameras()
        {
            if (cleared.Count > 0) return;
            var cameras = new HashSet<Camera>();
            var rig = Object.FindAnyObjectByType<OVRCameraRig>();
            if (rig != null)
            {
                if (rig.leftEyeCamera != null) cameras.Add(rig.leftEyeCamera);
                if (rig.rightEyeCamera != null) cameras.Add(rig.rightEyeCamera);
            }
            if (Camera.main != null) cameras.Add(Camera.main);
            foreach (var camera in cameras)
            {
                cleared.Add((camera, camera.clearFlags, camera.backgroundColor));
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = Color.clear;
            }
        }
    }
}
