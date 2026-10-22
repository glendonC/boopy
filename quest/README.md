# Boopy for Quest 3

The headset client. A session comes up in the room and shows the product: the spatial interface
for a person's existing personal AI.

**Your AI, in your world.**

## Requirements

- Unity `6000.3.25f1` with Android Build Support (its own SDK, NDK and OpenJDK).
- A Meta Quest 3 or 3S on Horizon OS v74 or later, in developer mode.
- .NET 10 SDK for the core's tests.

Pinned in `Packages/manifest.json`: OpenXR `1.18.0`, and Meta XR Core, Interaction, and MR
Utility Kit `207.0.0`.

## Layout

| Path | What |
| --- | --- |
| `Packages/com.boopy.client` | Engine-free core, tested on .NET |
| `Assets/Boopy/Runtime` | The Unity layer that brings a session up |
| `Assets/Boopy/Editor/BoopyBuild.cs` | Builds the scene from Meta's prefabs |
| `dotnet/` | The core's tests |

## Check

```bash
dotnet test dotnet/Boopy.Client.Tests
```
