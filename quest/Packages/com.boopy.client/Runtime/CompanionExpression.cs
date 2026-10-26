#nullable enable
using System;

namespace Boopy.Client
{
    /// <summary>Bounded visual expression; it never changes a capture or interaction target.</summary>
    public readonly struct CompanionExpression
    {
        public readonly float Lift, Pitch, Yaw, Roll, LeftEye, RightEye, LookX, LookY, Stretch, Fin;
        public readonly float LeftShoulder, RightShoulder, LeftElbow, RightElbow, RightWrist, Smile;

        private CompanionExpression(float lift, float pitch, float yaw, float roll, float leftEye,
            float rightEye, float lookX, float lookY, float stretch, float fin,
            float leftShoulder, float rightShoulder, float leftElbow, float rightElbow, float wrist, float smile)
        {
            Lift = lift; Pitch = pitch; Yaw = yaw; Roll = roll;
            LeftEye = leftEye; RightEye = rightEye; LookX = lookX; LookY = lookY;
            Stretch = stretch; Fin = fin;
            LeftShoulder = leftShoulder; RightShoulder = rightShoulder;
            LeftElbow = leftElbow; RightElbow = rightElbow; RightWrist = wrist; Smile = smile;
        }

        public static CompanionExpression At(string state, float clock, float elapsed, bool reduced,
            float attentionX = 0f, float attentionY = 0f, float greetingAge = float.PositiveInfinity,
            float speakingActivity = 0f)
        {
            if (state != "idle" && state != "listening" && state != "processing" && state != "review"
                && state != "saved" && state != "error" && state != "heard" && state != "not-heard" && state != "unclear")
                throw new ArgumentOutOfRangeException(nameof(state));
            clock = Finite(clock); elapsed = Math.Max(0f, Finite(elapsed));
            attentionX = Clamp(Finite(attentionX), -1f, 1f);
            attentionY = Clamp(Finite(attentionY), -1f, 1f);
            float lift = 0f, pitch = 0f, roll = 0f, stretch = 1f, fin = 0f;
            float left = .92f, right = .92f;
            float leftShoulder = 12f, rightShoulder = 12f, leftElbow = 18f, rightElbow = 18f, wrist = 0f, smile = 0f;
            // Listening, and an answer with no word of the language in it, turn to the person, not to the picture.
            if (state == "listening" || state == "unclear") { attentionX = 0f; attentionY = 0f; }
            var lookX = attentionX * .24f;
            var lookY = attentionY * .18f;
            switch (state)
            {
                case "listening":
                    pitch = -9f; lift = .003f; left = right = 1f; fin = -14f;
                    stretch = 1.035f;
                    leftShoulder = rightShoulder = 48f; leftElbow = rightElbow = 30f;
                    break;
                case "processing":
                    pitch = 5f; roll = -7f; left = .72f; right = .94f;
                    lookX += .10f; lookY += .08f; fin = 7f;
                    rightShoulder = 126f; rightElbow = 134f;
                    break;
                case "review":
                    pitch = -3f; left = right = 1f; fin = -8f;
                    leftShoulder = 30f; rightShoulder = 42f;
                    if (!reduced && elapsed < .4f)
                        pitch -= (float)Math.Sin(elapsed / .4f * Math.PI) * 5f;
                    break;
                case "saved":
                    left = right = .66f; pitch = 5f; fin = -20f;
                    leftShoulder = rightShoulder = 95f; leftElbow = rightElbow = 30f; smile = 1f;
                    if (!reduced && elapsed < .4f)
                    {
                        var arc = (float)Math.Sin(elapsed / .4f * Math.PI);
                        pitch = 5f - arc * 7f;
                        lift = arc * .002f;
                        stretch = 1f - arc * .015f;
                    }
                    break;
                case "error":
                    roll = 8f; pitch = 4f; left = .65f; right = .92f; fin = 10f;
                    leftShoulder = 55f; rightShoulder = 25f; leftElbow = 45f;
                    break;
                // What Boopy heard in an answer, on its body; never a grade.
                case "heard":
                    // One hop; reduced motion keeps the resting pose and lets only the eyes smile.
                    pitch = -3f; fin = -8f; leftShoulder = 30f; rightShoulder = 42f;
                    left = right = .66f;
                    if (!reduced)
                    {
                        smile = 1f; fin = -20f; leftShoulder = rightShoulder = 95f; leftElbow = rightElbow = 30f;
                        if (elapsed < .5f)
                        {
                            var arc = (float)Math.Sin(elapsed / .5f * Math.PI);
                            lift = arc * .006f; pitch = -3f - arc * 6f; stretch = 1f - arc * .02f;
                        }
                    }
                    break;
                case "not-heard":
                    // It points at the word it listened for, and looks there.
                    pitch = -2f; left = right = 1f; fin = -6f;
                    leftShoulder = 24f; rightShoulder = 112f; rightElbow = 18f; wrist = 10f;
                    break;
                case "unclear":
                    // It tilts toward the person, as if to say it did not catch it.
                    roll = -11f; pitch = 3f; left = right = .9f; fin = 6f;
                    leftShoulder = 36f; rightShoulder = 20f;
                    break;
            }
            if (!reduced)
            {
                if (state == "idle" || state == "listening")
                    lift += (float)Math.Sin(clock * .85f) * .0007f;
                var phase = clock % 5.7f;
                var blink = phase >= 5.48f
                    ? (float)Math.Sin((phase - 5.48f) / .22f * Math.PI) : 0f;
                left *= 1f - Clamp(blink, 0f, 1f);
                right *= 1f - Clamp(blink, 0f, 1f);
            }
            var speech = Clamp(Finite(speakingActivity), 0f, 1f);
            if (speech > 0f && state != "listening" && state != "processing")
            {
                // Real playback energy, never text length or an invented speaking clock.
                lift = reduced ? 0f : .0005f + .002f * speech;
                pitch = reduced ? -6f : -6f - 3f * speech;
                roll = 0f; stretch = reduced ? 1f : 1f + .015f * speech;
                left = right = 1f; smile = .12f;
                leftShoulder = rightShoulder = 58f;
                leftElbow = rightElbow = 25f; wrist = 0f;
            }
            return new CompanionExpression(lift, pitch, attentionX * 9f, roll,
                Math.Max(.035f, left), Math.Max(.035f, right), Clamp(lookX, -.24f, .24f), Clamp(lookY, -.18f, .18f), stretch, fin,
                leftShoulder, rightShoulder, leftElbow, rightElbow, wrist, smile);
        }

        private static float Finite(float value) => float.IsNaN(value) || float.IsInfinity(value) ? 0f : value;
        private static float Clamp(float value, float min, float max) => Math.Max(min, Math.Min(max, value));
    }
}
