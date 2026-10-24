#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using Boopy.Client;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Boopy.Quest.Editor
{
    /// <summary>
    /// One row on every surface, through BoopyApp with synthetic views. Every control the console shows, in every state, is
    /// a tile of the one row under the panel: the same 0.124 by 0.060 tile with its filled glyph, live, Pause in slot 2, a
    /// speak tile only in slot 1 and Back only in slot 3. Nothing sits on a panel, sheet or card. Lists show one item at a
    /// time on the panel, paged with a pinch on the panel, with "n of N" where the speaker line sits, and the row acts on the
    /// item shown: the evidence choice [Talk, Pause, No view or View], a choice [Talk, Pause, Choose] over its options,
    /// follow-ups behind Boopy's line [Talk, Pause, More] then [Talk, Pause, Ask], More [Context, Pause, More] then
    /// [Settings, Pause, Back], the Context sheet's actions paged with More and ending in Back, Settings one per page
    /// [Turn on or Turn off, Pause, Back], the receipts [Use or Dismiss, Pause, Back], the reader [Exclude or Include, Pause,
    /// More] then [Source, Pause, Back] and its Source [Confirm, Pause, Back], and manual recovery [Check, Pause, New].
    /// A choice's option starts its own paragraph one gap under its prompt, a long prompt and its option sharing one taller
    /// page; Settings keeps one height on every page; the line's panel stays inside the console's; and Boopy's words on the
    /// console's own panel (a turn with no line, the opening) sit on the line's dark panel, hugging them and ending one gap
    /// above the row. Head-on stills of each state, standard and large. In batch mode any failure exits non-zero.
    /// </summary>
    public static class OneRowValidation
    {
        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
        private const string Identity = "00000000-0000-4000-8000-000000000042";
        private static readonly ConsoleAction[] Speak = { ConsoleAction.Talk, ConsoleAction.AnswerTask, ConsoleAction.FinishTalk };
        private static readonly ConsoleAction[] Backs = { ConsoleAction.Back, ConsoleAction.ShelfBack };
        private static string output = "";
        private static string size = "";

        public static void Run()
        {
            var context = SynchronizationContext.Current;
            output = Path.Combine(Path.GetTempPath(), "boopy-one-row");
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                HangulFont.Install();
                SynchronizationContext.SetSynchronizationContext(null);
                Directory.CreateDirectory(output);
                foreach (var large in new[] { false, true }) { size = large ? "large" : "standard"; Validate(large); }
                Debug.Log("Boopy one row validation passed: every control in every state is a tile of the one row, Pause in slot 2, "
                    + "speak tiles first and Back last, lists paged on the panel with n of N; stills in " + output + " (synthetic).");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                else throw;
            }
            finally { SynchronizationContext.SetSynchronizationContext(context); }
        }

        private static void Validate(bool large)
        {
            using (var f = new TaskPresentationValidation.Fixture(large))
            {
                var camera = ControlGrammarValidation.Camera(f);
                f.Console.SetConnectionStatus("connected", true);

                // A statement with nothing to follow: Talk, Pause, More.
                var statement = View(); statement.Dialogue!.Actions.Clear();
                Apply(f, statement);
                Row(f, camera, "statement", ConsoleAction.Talk, ConsoleAction.More);

                // A turn with no line for it: Boopy's words on the console's own panel sit on the line's dark panel.
                var quiet = View(); quiet.Dialogue = null;
                Apply(f, quiet);
                WordsOnPanel(f, "words-on-panel", "Talk to continue.");
                Row(f, camera, "words-on-panel", ConsoleAction.Talk, ConsoleAction.More);

                // More pages in place: Context, then Settings and Back; Back returns the conversation.
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "more-1", ConsoleAction.Options, ConsoleAction.More);
                Labeled(f, ConsoleAction.Options, "Context", "context");
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "more-2", ConsoleAction.Settings, ConsoleAction.ShelfBack);
                Labeled(f, ConsoleAction.Settings, "Settings", "settings"); Labeled(f, ConsoleAction.ShelfBack, "Back", "back");
                f.Console.Activate(ConsoleAction.ShelfBack);
                Row(f, null, "Back from More", ConsoleAction.Talk, ConsoleAction.More);

                // Follow-ups page behind Boopy's line: the line with More, then one question per page with Ask.
                var two = View();
                Apply(f, two);
                Line(f, "follow-ups 1 of 3", TaskPresentationValidation.Line, "1 of 3");
                Row(f, camera, "follow-ups-1", ConsoleAction.Talk, ConsoleAction.More);
                Page(f);
                Line(f, "follow-ups 2 of 3", "Who placed this marker?", "2 of 3");
                Row(f, camera, "follow-ups-2", ConsoleAction.Talk, ConsoleAction.FollowUpOne);
                Labeled(f, ConsoleAction.FollowUpOne, "Ask", "ask");
                Require(f.Console.SuggestedAction(ConsoleAction.FollowUpOne)?.Id == "question-origin", "Ask does not send the question shown.");
                Page(f);
                Line(f, "follow-ups 3 of 3", "What does the nearby sign say?", "3 of 3");
                Row(f, camera, "follow-ups-3", ConsoleAction.Talk, ConsoleAction.FollowUpTwo);
                Labeled(f, ConsoleAction.FollowUpTwo, "Ask", "ask");
                Require(f.Console.SuggestedAction(ConsoleAction.FollowUpTwo)?.Id == "question-sign", "Ask does not send the question shown.");
                Page(f);
                Line(f, "follow-ups wrap", TaskPresentationValidation.Line, "1 of 3");
                Row(f, null, "Follow-ups wrap", ConsoleAction.Talk, ConsoleAction.More);
                var one = View(); one.Dialogue!.Actions.RemoveAt(1); one.Dialogue.At = "1970-01-01T12:00:01Z";
                Apply(f, one);
                Line(f, "one follow-up", TaskPresentationValidation.Line, "1 of 2");
                Page(f);
                Line(f, "one follow-up 2 of 2", "Who placed this marker?", "2 of 2");
                Row(f, camera, "follow-up-one", ConsoleAction.Talk, ConsoleAction.FollowUpOne);

                // A choice: Boopy's prompt and one option under it, paged, and Choose sends the option shown.
                foreach (var count in new[] { 2, 3 })
                {
                    var choice = View(choice: true);
                    if (count == 3) choice.Dialogue!.Choice!.Options.Add(new ChoiceOption { Id = "option-path", Label = "The path", Value = "The path" });
                    Apply(f, choice);
                    var labels = choice.Dialogue!.Choice!.Options.Select(option => option.Label).ToArray();
                    for (var index = 0; index <= count; index++)
                    {
                        var shown = index % count;
                        Line(f, "choice of " + count + ", page " + (index + 1), labels[shown], (shown + 1) + " of " + count);
                        Require(f.Strip.VisibleText.Contains("Which one do you mean?"), "The choice's page does not keep its prompt: " + f.Strip.VisibleText);
                        OptionUnderPrompt(f, "choice of " + count + ", page " + (index + 1), labels[shown]);
                        Row(f, index < count ? camera : null, "choice-" + count + "-" + (shown + 1), ConsoleAction.Talk, ConsoleAction.SendChoice);
                        // A page with its prompt and one option still ends one gap above the row.
                        ControlGrammarValidation.GapAboveShelf(f, "choice of " + count + ", page " + (index + 1));
                        Labeled(f, ConsoleAction.SendChoice, "Choose", "confirm");
                        Require(f.Console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId == choice.Dialogue.Choice.Options[shown].Id,
                            "Choose does not send the option shown (" + labels[shown] + ").");
                        Page(f);
                    }
                }

                // A card with one option is outside the contract (two or three): it reads as Boopy's line, with nothing to choose.
                var single = View(choice: true); single.Dialogue!.Choice!.Options.RemoveAt(1);
                Apply(f, single);
                Row(f, camera, "choice-1", ConsoleAction.Talk, ConsoleAction.More);
                Require(f.Console.SelectedChoice(ConsoleAction.SendChoice) == null && f.Strip.VisibleText.Contains("Which one do you mean?"),
                    "A one-option card offers a choice, or hides Boopy's line: " + f.Strip.VisibleText);

                // A long prompt and its option share one page; the console's panel grows to hold it.
                var wordy = View(choice: true);
                wordy.Dialogue!.Text = wordy.Dialogue.Choice!.Prompt = "Which of the two marks along this part of the trail do you mean when you ask what it is and who placed it here?";
                wordy.Dialogue.Choice.Options[0].Label = wordy.Dialogue.Choice.Options[0].Value = "The carved stone beside the path";
                wordy.Dialogue.Choice.Options[1].Label = wordy.Dialogue.Choice.Options[1].Value = "The painted arrow on the post";
                Apply(f, wordy);
                Line(f, "a long choice", "The carved stone beside the path", "1 of 2");
                Require(f.Strip.VisibleText.StartsWith(wordy.Dialogue.Text, StringComparison.Ordinal) && f.Strip.PanelHeight > .161f,
                    "A long prompt and its option do not share one taller page: " + f.Strip.PanelHeight.ToString("0.000") + ", " + f.Strip.VisibleText);
                OptionUnderPrompt(f, "a long choice", "The carved stone beside the path");
                Row(f, camera, "choice-long", ConsoleAction.Talk, ConsoleAction.SendChoice);
                ControlGrammarValidation.GapAboveShelf(f, "a long choice");

                // At the contract's limit, a 160-character prompt with three 60-character options: every page keeps the prompt with
                // one option under it, all at one height inside the console's reserved panel, Choose sends the one shown, and the
                // last wraps.
                var longest = View(choice: true);
                longest.Dialogue!.Text = longest.Dialogue.Choice!.Prompt = "Which of the three markers along this stretch of the trail do you mean when you ask what it is, who placed it there, and whether it still points the way you go?";
                longest.Dialogue.Choice.Options[0].Label = longest.Dialogue.Choice.Options[0].Value = "The carved stone at the foot of the hill beside the old gate";
                longest.Dialogue.Choice.Options[1].Label = longest.Dialogue.Choice.Options[1].Value = "The painted arrow on an old wooden post where the paths join";
                longest.Dialogue.Choice.Options.Add(new ChoiceOption { Id = "option-plate", Label = "The small metal plate fixed to the rock above the dry stream", Value = "The small metal plate fixed to the rock above the dry stream" });
                Apply(f, longest);
                var offered = longest.Dialogue.Choice.Options;
                var total = f.Strip.PageCount; var reached = 0; var tallest = f.Strip.PanelHeight;
                Require(total == offered.Count, "The longest choice does not keep its prompt on each option's page: " + total + " pages for " + offered.Count + " options.");
                for (var index = 0; index <= total; index++)
                {
                    var shown = f.Strip.ShownItem;
                    var when = "choice-max-" + (index % total + 1);
                    Require(shown == index % total && f.Strip.VisibleText.StartsWith(longest.Dialogue.Text, StringComparison.Ordinal),
                        when + ": the page does not show the prompt with option " + (index % total + 1) + ": " + f.Strip.VisibleText);
                    Line(f, when, offered[shown].Label, (index % total + 1) + " of " + total);
                    OptionUnderPrompt(f, when, offered[shown].Label);
                    Require(Mathf.Abs(f.Strip.PanelHeight - tallest) < .0005f, when + ": the line's panel changes height while paging.");
                    Row(f, index < total ? camera : null, when, ConsoleAction.Talk, ConsoleAction.SendChoice);
                    ControlGrammarValidation.GapAboveShelf(f, when);
                    Require(f.Console.SelectedChoice(ConsoleAction.SendChoice)?.OptionId == offered[shown].Id, when + ": Choose does not send the option shown.");
                    reached |= 1 << shown;
                    Page(f);
                }
                Require(reached == 7, "The longest choice does not reach every option.");
                Debug.Log("Boopy one row (synthetic): the contract's longest choice keeps a line's panel " + (tallest * 1000f).ToString("0") + " mm tall in the line's frame, "
                    + (tallest * f.Console.ComfortScale * 1000f).ToString("0") + " mm in the room (" + size + ").");

                // The evidence choice: one tile that switches the next turn's photo, its words on the line.
                var ask = View(); ask.Dialogue!.Actions.Clear(); ask.Dialogue.Text = "Could you show me its base?";
                ask.Attention = new AttentionView { UtteranceId = "synthetic-turn", Action = "fresh-view", Source = "current-surroundings" };
                Apply(f, ask);
                Row(f, camera, "evidence-photo-on", ConsoleAction.Talk, ConsoleAction.UseSpokenOnly);
                Labeled(f, ConsoleAction.UseSpokenOnly, null, "no-camera");
                f.Console.Activate(ConsoleAction.UseSpokenOnly);
                Require(f.Console.InputPolicy.SpokenOnly && f.Strip.VisibleText.Contains("photo sharing off"), "No view does not switch the next turn: " + f.Strip.VisibleText);
                Row(f, camera, "evidence-photo-off", ConsoleAction.Talk, ConsoleAction.UseCurrentView);
                Labeled(f, ConsoleAction.UseCurrentView, null, "camera");
                f.Console.Activate(ConsoleAction.UseCurrentView);
                Require(!f.Console.InputPolicy.SpokenOnly && f.Strip.VisibleText.Contains("Look toward the subject"), "View does not switch the next turn back: " + f.Strip.VisibleText);
                Row(f, null, "Evidence switched back", ConsoleAction.Talk, ConsoleAction.UseSpokenOnly);

                // The Context sheet for the current context: Prepare, then Review and Back.
                var current = View(); current.Dialogue!.Actions.Clear(); current.Dialogue.At = "1970-01-01T12:00:02Z";
                current.Items.Add(new Item { Id = "synthetic-note", Kind = "object", Label = "Painted arrow", Statement = "You said the arrow points north.",
                    Origin = "person", Status = "confirmed", Grounding = new Grounding { Kind = "scene" } });
                Apply(f, current);
                OpenContext(f);
                Row(f, camera, "context-current-1", ConsoleAction.PrepareSave, ConsoleAction.More);
                Labeled(f, ConsoleAction.PrepareSave, "Prepare", "prepare");
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "context-current-2", ConsoleAction.Review, ConsoleAction.ShelfBack);
                Labeled(f, ConsoleAction.Review, "Review", "review");

                // The reader: items paged on the card, Exclude then Source; Source with Confirm when the item can be confirmed.
                f.Console.Activate(ConsoleAction.Review);
                Count(f, "Reader", "Evidence instrument", "1 of 2");
                Row(f, camera, "reader-item", ConsoleAction.ToggleIncluded, ConsoleAction.More);
                Labeled(f, ConsoleAction.ToggleIncluded, "Exclude", "minus");
                OneHeight(f, "reader items");
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "reader-item-more", ConsoleAction.ToggleDetails, ConsoleAction.ShelfBack);
                Labeled(f, ConsoleAction.ToggleDetails, "Source", "source");
                f.Console.Activate(ConsoleAction.ToggleDetails);
                Row(f, camera, "reader-source-confirm", ConsoleAction.Confirm, ConsoleAction.ShelfBack);
                Labeled(f, ConsoleAction.Confirm, "Confirm", "confirm");
                OneHeight(f, "reader source pages");
                f.Console.Activate(ConsoleAction.ShelfBack);
                Row(f, null, "Back from Source", ConsoleAction.ToggleIncluded, ConsoleAction.More);
                CardPage(f);
                Count(f, "Reader, second item", "Evidence instrument", "2 of 2");
                f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.ToggleDetails);
                Row(f, camera, "reader-source", ConsoleAction.None, ConsoleAction.ShelfBack);
                f.Console.Activate(ConsoleAction.ShelfBack); f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.ShelfBack);
                Row(f, null, "Back from the reader", ConsoleAction.PrepareSave, ConsoleAction.More);

                // The save preview: Use, Pause, Back.
                f.Console.Activate(ConsoleAction.PrepareSave);
                Row(f, camera, "save-preview", ConsoleAction.Save, ConsoleAction.Back);
                Labeled(f, ConsoleAction.Save, "Use", "confirm"); Labeled(f, ConsoleAction.Back, "Back", "back");
                f.Console.Activate(ConsoleAction.Back);
                Row(f, null, "Back from the save preview", ConsoleAction.Talk, ConsoleAction.More);

                // An earlier preparation to check, with the current context: Check, Prepare, then Review and Back.
                f.Console.SetHandoffRecovery(true, true, "pkg_synthetic", "req_synthetic", false);
                OpenContext(f);
                Row(f, camera, "context-both-1", ConsoleAction.Handoff, ConsoleAction.More);
                Labeled(f, ConsoleAction.Handoff, "Check", "check");
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "context-both-2", ConsoleAction.PrepareSave, ConsoleAction.More);
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "context-both-3", ConsoleAction.Review, ConsoleAction.ShelfBack);
                f.Console.Activate(ConsoleAction.ShelfBack);
                f.Console.SetHandoffRecovery(false, false, null, null, false);

                // Settings: first what is connected, with no left tile; then one setting per page, Turn on or Turn off with the
                // setting's glyph, then Back.
                Apply(f, statement);
                f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.Settings);
                var pages = new[]
                {
                    (ConsoleAction.Size, "Large text", "text", large), (ConsoleAction.Sound, "Sound", "sound", true),
                    (ConsoleAction.Motion, "Reduced motion", "motion", false), (ConsoleAction.Speech, "Voice", "voice", true),
                    (ConsoleAction.EvidenceSource, "Photo", "camera", true),
                };
                // Every page keeps the first page's height, so the sheet stays under the pinch that pages it.
                Settle(f);
                var sheetHeight = Sheet(f).Size.y;
                var settingsCount = pages.Length + 1;
                for (var index = 0; index <= settingsCount; index++)
                {
                    var shown = index % settingsCount;
                    Require(Mathf.Abs(Sheet(f).Size.y - sheetHeight) < .0005f, "Settings changes height on page " + (shown + 1) + ".");
                    if (shown == 0)
                    {
                        Count(f, "Settings status", "Comfort options", "1 of " + settingsCount);
                        Require(Sheet(f).BodyText.StartsWith("Your AI is not connected.\n", StringComparison.Ordinal),
                            "Settings does not open with what is connected: " + Sheet(f).BodyText);
                        Row(f, index < settingsCount ? camera : null, "settings-1", ConsoleAction.None, ConsoleAction.ShelfBack);
                        SheetPage(f);
                        continue;
                    }
                    var (action, name, glyph, on) = pages[shown - 1];
                    Count(f, "Settings " + name, "Comfort options", (shown + 1) + " of " + settingsCount);
                    Require(Sheet(f).BodyText.Contains(name + " is " + (on ? "on." : "off.")), "Settings does not say " + name + " is " + (on ? "on" : "off") + ": " + Sheet(f).BodyText);
                    Row(f, index < settingsCount ? camera : null, "settings-" + (shown + 1), action, ConsoleAction.ShelfBack);
                    Labeled(f, action, on ? "Turn off" : "Turn on", glyph);
                    SheetPage(f);
                }
                // On from Large text to Sound.
                SheetPage(f);
                // Turning a setting off says so and offers to turn it back on.
                f.Console.Activate(ConsoleAction.Sound);
                Require(Sheet(f).BodyText.Contains("Sound is off.") && Control(f, ConsoleAction.Sound).AccessibleLabel == "Turn on", "Turning Sound off does not show.");
                f.Console.Activate(ConsoleAction.Sound);
                f.Console.Activate(ConsoleAction.ShelfBack);
                Row(f, null, "Back from Settings", ConsoleAction.Talk, ConsoleAction.More);
                // While Voice is unavailable its page says so and has no left tile.
                var silent = View(); silent.Dialogue!.Actions.Clear(); silent.SpeechOutputAvailable = false;
                Apply(f, silent);
                f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.More); f.Console.Activate(ConsoleAction.Settings);
                for (var index = 0; index < 4; index++) SheetPage(f);
                Require(Sheet(f).BodyText.Contains("Voice is unavailable."), "Settings does not say Voice is unavailable: " + Sheet(f).BodyText);
                Row(f, camera, "settings-voice-unavailable", ConsoleAction.None, ConsoleAction.ShelfBack);
                f.Console.Activate(ConsoleAction.ShelfBack);

                // A kept context: the handoff's one-word action, then Review; its receipt with nothing to do is Back alone, and
                // with a headset record to remove, Dismiss.
                var kept = View(); kept.Dialogue!.Actions.Clear(); kept.State = "committed"; kept.Committed = new Committed { PackageId = "pkg_synthetic" };
                Apply(f, kept);
                OpenContext(f);
                Row(f, camera, "context-committed-1", ConsoleAction.Handoff, ConsoleAction.More);
                Labeled(f, ConsoleAction.Handoff, "Prepare", "prepare");
                f.Console.Activate(ConsoleAction.More);
                Row(f, camera, "context-committed-2", ConsoleAction.Review, ConsoleAction.ShelfBack);
                f.Console.Activate(ConsoleAction.ShelfBack);
                OpenContext(f); f.Console.Activate(ConsoleAction.Handoff);
                Row(f, camera, "handoff-receipt", ConsoleAction.None, ConsoleAction.Back);
                f.Console.SetHandoffRecovery(true, false, "pkg_synthetic", "req_synthetic", false);
                Row(f, camera, "handoff-prepared", ConsoleAction.DismissCapture, ConsoleAction.Back);
                Labeled(f, ConsoleAction.DismissCapture, "Dismiss", "cancel");
                f.Console.Activate(ConsoleAction.Back);
                f.Console.SetHandoffRecovery(false, false, null, null, false);
            }

            // An earlier preparation with nothing else to do: Check, then Back.
            using (var e = new TaskPresentationValidation.Fixture(large))
            {
                var camera = ControlGrammarValidation.Camera(e);
                e.Console.SetConnectionStatus("connected", true);
                // The opening greeting sits on the line's dark panel too.
                WordsOnPanel(e, "opening", "Hi, I’m Boopy. Show me what you want kept.");
                Row(e, camera, "opening", ConsoleAction.Talk, ConsoleAction.More);
                e.Console.SetHandoffRecovery(true, true, "pkg_synthetic", "req_synthetic", false);
                OpenContext(e);
                Row(e, camera, "context-earlier", ConsoleAction.Handoff, ConsoleAction.ShelfBack);
                Labeled(e, ConsoleAction.Handoff, "Check", "check");
            }

            // A capture left pending by a restart: Check, Pause, New.
            using (var r = new TaskPresentationValidation.Fixture(large))
            {
                var camera = ControlGrammarValidation.Camera(r);
                ((CaptureRecoveryStore)Get(r.App, "recoveryStore")!).Save(Identity);
                Invoke(r.App, "RestoreCaptureRecovery");
                Row(r, camera, "manual-recovery", ConsoleAction.CheckCapture, ConsoleAction.DismissCapture);
                Labeled(r, ConsoleAction.CheckCapture, "Check", "check"); Labeled(r, ConsoleAction.DismissCapture, "New", "new");
            }
        }

        // Exactly [first, Pause, third], and nothing anywhere else: every control the console shows is a live tile of the one
        // row with its glyph, a pinch on it reaches it and no panel's paging takes it, a speak tile only first and Back only
        // last. A named state is also a still.
        private static void Row(TaskPresentationValidation.Fixture f, Camera? camera, string when, ConsoleAction first, ConsoleAction third)
        {
            Settle(f);
            var bar = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Control bar");
            var shown = f.Console.GetComponentsInChildren<SpatialAction>()
                .Where(control => control.gameObject.activeInHierarchy && control.GetComponentInParent<DialogueStrip>(true) == null).ToArray();
            foreach (var control in shown)
            {
                var what = when + ": " + control.Action + " (\"" + control.AccessibleLabel + "\")";
                Require(control.transform.parent == bar.transform, what + " sits on " + control.transform.parent.name + ", not in the row.");
                Require((bool)Get(control, "interactable")!, what + " shows as an inactive tile.");
                var icon = control.GetComponentsInChildren<SpatialActionIcon>(true).SingleOrDefault();
                Require(icon != null && icon.Drawn, what + " has no glyph.");
                var ray = new Ray(f.Eyes.position, control.transform.position - f.Eyes.position);
                Require(f.Console.HitAction(ray, out _) == control.Action && !f.Strip.HitPage(ray) && !f.Console.HitPage(ray), what + " is not what a pinch on it reaches.");
            }
            // The line's panel stays inside the console's own panel, which reserves its full height.
            if (f.Strip.gameObject.activeInHierarchy)
            {
                var header = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
                var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing").transform;
                var top = f.Console.transform.InverseTransformPoint(backing.TransformPoint(new Vector3(0f, .5f, 0f))).y;
                Require(top <= header.transform.localPosition.y + header.Size.y / 2f + .001f, when + ": the line's panel reaches " + ((top - header.transform.localPosition.y - header.Size.y / 2f) * 1000f).ToString("0")
                    + " mm above the console's reserved panel.");
            }
            // Sheets and cards sit on the line's column; the Context sheet, named on its top line, hugs its words.
            foreach (var surface in f.Console.GetComponentsInChildren<SpatialSurface>().Where(surface => surface.name == "Comfort options" || surface.name == "Evidence instrument"))
            {
                OnColumn(f, when, surface);
                if (surface.name == "Comfort options" && !surface.StateText.StartsWith("Settings", StringComparison.Ordinal)) ContextSheet(when, surface);
            }
            ControlGrammarValidation.Shelf(f, when, first, ConsoleAction.PauseScene, third);
            ControlGrammarValidation.OneStyle(f, when);
            foreach (var control in shown.Where(control => Speak.Contains(control.Action)))
                Require(Slot(f, control) == 0, when + ": the speak tile " + control.Action + " is not first.");
            foreach (var control in shown.Where(control => Backs.Contains(control.Action)))
                Require(Slot(f, control) == 2, when + ": Back is not last.");
            if (camera != null) ControlGrammarValidation.Shot(f, camera, Path.Combine(output, when + "-" + size + ".png"));
        }

        // The option shown starts its own paragraph one gap under its prompt, in the prompt's type.
        private static void OptionUnderPrompt(TaskPresentationValidation.Fixture f, string when, string option)
        {
            Settle(f);
            var texts = f.Strip.GetComponentsInChildren<TextMeshPro>(true);
            var prompt = texts.Single(text => text.name == "Actual response");
            var item = texts.SingleOrDefault(text => text.name == "Shown item");
            Require(item != null && item.gameObject.activeInHierarchy && item.text == option && item.font == prompt.font
                && Mathf.Approximately(item.fontSize, prompt.fontSize) && Same(item.color, prompt.color),
                when + ": the option is not its own paragraph in the prompt's type: " + f.Strip.VisibleText);
            prompt.ForceMeshUpdate(true, true); item.ForceMeshUpdate(true, true);
            var promptBottom = f.Strip.transform.InverseTransformPoint(prompt.transform.TransformPoint(prompt.textBounds.min)).y;
            var itemTop = f.Strip.transform.InverseTransformPoint(item.transform.TransformPoint(item.textBounds.max)).y;
            Require(Mathf.Abs(promptBottom - itemTop - SpatialTheme.Gap) < .002f,
                when + ": the option sits " + ((promptBottom - itemTop) * 1000f).ToString("0") + " mm under its prompt, not 14.");
            // Its words stay on the line's dark panel.
            var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing").transform;
            var panelBottom = f.Strip.transform.InverseTransformPoint(backing.TransformPoint(new Vector3(0f, -.5f, 0f))).y;
            var itemBottom = f.Strip.transform.InverseTransformPoint(item.transform.TransformPoint(item.textBounds.min)).y;
            Require(itemBottom >= panelBottom, when + ": the option's words reach " + ((panelBottom - itemBottom) * 1000f).ToString("0") + " mm below the line's panel.");
        }

        // Boopy's words on the console's own panel, with no line docked over them, sit inside the line's dark panel, which
        // ends one gap above the row.
        private static void WordsOnPanel(TaskPresentationValidation.Fixture f, string when, string words)
        {
            Settle(f);
            var header = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Intent instrument");
            var texts = header.GetComponentsInChildren<TextMeshPro>(true).Where(text => text.GetComponentInParent<DialogueStrip>(true) == null
                && text.gameObject.activeInHierarchy && text.GetComponent<MeshRenderer>().enabled && !string.IsNullOrWhiteSpace(text.text)).ToArray();
            Require(!f.Strip.gameObject.activeInHierarchy && texts.Any(text => text.text == words),
                when + ": the panel does not show \"" + words + "\": [" + string.Join(" | ", texts.Select(text => text.text)) + "].");
            var backing = header.GetComponentsInChildren<MeshRenderer>(true).SingleOrDefault(renderer => renderer.name == "Dialog backing");
            Require(backing != null && backing.enabled && backing.gameObject.activeInHierarchy, when + ": Boopy's words have no dark panel behind them.");
            var tint = new MaterialPropertyBlock(); backing!.GetPropertyBlock(tint);
            Require(Same(tint.GetColor("_Color"), SpatialTheme.Panel), when + ": the words' panel is not the line's panel color.");
            var low = f.Console.transform.InverseTransformPoint(backing.transform.TransformPoint(new Vector3(-.5f, -.5f, 0f)));
            var high = f.Console.transform.InverseTransformPoint(backing.transform.TransformPoint(new Vector3(.5f, .5f, 0f)));
            float inkLow = float.PositiveInfinity, inkHigh = float.NegativeInfinity;
            foreach (var text in texts)
            {
                text.ForceMeshUpdate(true, true);
                var a = f.Console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.min));
                var b = f.Console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.max));
                Require(Mathf.Min(a.x, b.x) >= low.x - .001f && Mathf.Max(a.x, b.x) <= high.x + .001f && Mathf.Min(a.y, b.y) >= low.y - .001f
                    && Mathf.Max(a.y, b.y) <= high.y + .001f, when + ": \"" + text.text + "\" sits off its panel.");
                inkLow = Mathf.Min(inkLow, Mathf.Min(a.y, b.y)); inkHigh = Mathf.Max(inkHigh, Mathf.Max(a.y, b.y));
            }
            // The panel hugs its words: no height reserved for anything else.
            Require(high.y - inkHigh <= .030f && inkLow - low.y <= .030f, when + ": the words' panel leaves " + ((high.y - inkHigh) * 1000f).ToString("0") + " mm above them and "
                + ((inkLow - low.y) * 1000f).ToString("0") + " mm below.");
            ControlGrammarValidation.GapAboveShelf(f, when, backing.transform);
        }

        // A sheet or card on the line's column: its dark panel spans the text column with the line's 12 mm side margin, and its
        // words start on the text column and end inside it.
        private static void OnColumn(TaskPresentationValidation.Fixture f, string when, SpatialSurface surface)
        {
            var plate = surface.GetComponentsInChildren<MeshFilter>(true).Single(filter => filter.name == "Readability island");
            var bounds = plate.sharedMesh.bounds;
            var left = f.Console.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.min)).x;
            var right = f.Console.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.max)).x;
            Require(Mathf.Abs(left - (SpatialTheme.ShelfLeft - .012f)) < .001f && Mathf.Abs(right - (SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth + .012f)) < .001f,
                when + ": " + surface.name + "'s panel spans x " + left.ToString("0.000") + " to " + right.ToString("0.000") + ", not the text column with the line's 12 mm margins.");
            foreach (var text in surface.GetComponentsInChildren<TextMeshPro>().Where(text => !string.IsNullOrWhiteSpace(text.text)))
            {
                text.ForceMeshUpdate(true, true);
                var start = f.Console.transform.InverseTransformPoint(text.transform.TransformPoint(new Vector3(-text.rectTransform.sizeDelta.x / 2f, 0f, 0f))).x;
                var end = f.Console.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.max)).x;
                Require(Mathf.Abs(start - SpatialTheme.ShelfLeft) < .001f && end <= SpatialTheme.ShelfLeft + SpatialTheme.ShelfWidth + .001f,
                    when + ": \"" + text.text + "\" on " + surface.name + " does not sit on the text column (" + start.ToString("0.000") + " to " + end.ToString("0.000") + ").");
            }
        }

        // The Context sheet's top line names it in the Settings line's style, and its panel hugs its words.
        private static void ContextSheet(string when, SpatialSurface sheet)
        {
            var state = sheet.GetComponentsInChildren<TextMeshPro>(true).Single(text => text.name == "State");
            Require(sheet.StateText == "Context" && state.gameObject.activeInHierarchy && Mathf.Approximately(state.fontSize, SpatialTheme.Utility) && Same(state.color, SpatialTheme.Smoke),
                when + ": the Context sheet's top line reads \"" + sheet.StateText + "\", not \"Context\" in the Settings line's style.");
            var (above, below) = Bands(sheet);
            Require(Mathf.Abs(below - above) <= .004f, when + ": the Context sheet leaves " + Mm(above) + " mm over its words and " + Mm(below) + " mm under them.");
        }

        // The reader keeps one height across its pages, its tallest page's, which hugs its words.
        private static void OneHeight(TaskPresentationValidation.Fixture f, string when)
        {
            Settle(f);
            var card = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Evidence instrument");
            var first = card.StateText; var height = card.Size.y; var tightest = float.PositiveInfinity;
            for (var turn = 0; turn < 12; turn++)
            {
                Require(Mathf.Abs(card.Size.y - height) < .0005f, when + ": the card is " + Mm(card.Size.y) + " mm tall on \"" + card.StateText + "\", not " + Mm(height) + ".");
                var (above, below) = Bands(card);
                tightest = Mathf.Min(tightest, below - above);
                if (!card.StateText.Contains(" of ")) break;
                CardPage(f); Settle(f);
                if (card.StateText == first) break;
            }
            Require(Mathf.Abs(tightest) <= .004f, when + ": the card's tallest page leaves " + Mm(tightest) + " mm more under its words than over them.");
        }

        // The panel's room over its first words and under its last, in the surface's own frame.
        private static (float Above, float Below) Bands(SpatialSurface surface)
        {
            var plate = surface.GetComponentsInChildren<MeshFilter>(true).Single(filter => filter.name == "Readability island");
            var bounds = plate.sharedMesh.bounds;
            var top = surface.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.max)).y;
            var bottom = surface.transform.InverseTransformPoint(plate.transform.TransformPoint(bounds.min)).y;
            float inkTop = float.NegativeInfinity, inkBottom = float.PositiveInfinity;
            foreach (var text in surface.GetComponentsInChildren<TextMeshPro>().Where(text => !string.IsNullOrWhiteSpace(text.text)))
            {
                text.ForceMeshUpdate(true, true);
                inkTop = Mathf.Max(inkTop, surface.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.max)).y);
                inkBottom = Mathf.Min(inkBottom, surface.transform.InverseTransformPoint(text.transform.TransformPoint(text.textBounds.min)).y);
            }
            return (top - inkTop, inkBottom - bottom);
        }

        private static string Mm(float metres) => (metres * 1000f).ToString("0");

        private static bool Same(Color a, Color b) => Mathf.Abs(a.r - b.r) < .02f && Mathf.Abs(a.g - b.g) < .02f && Mathf.Abs(a.b - b.b) < .02f;

        private static int Slot(TaskPresentationValidation.Fixture f, SpatialAction control)
        {
            var left = f.Console.transform.InverseTransformPoint(control.transform.position).x - SpatialTheme.ShelfSlot / 2f;
            return Mathf.RoundToInt((left - SpatialTheme.ShelfLeft) / (SpatialTheme.ShelfSlot + SpatialTheme.Gap));
        }

        // The tile's words (null leaves them to the 3 mm fit) and glyph.
        private static void Labeled(TaskPresentationValidation.Fixture f, ConsoleAction action, string? words, string glyph)
        {
            var control = Control(f, action);
            Require(words == null || control.AccessibleLabel == words, action + " reads \"" + control.AccessibleLabel + "\", not \"" + words + "\".");
            var icon = control.GetComponentsInChildren<SpatialActionIcon>(true).SingleOrDefault();
            Require(icon != null && icon.Kind == glyph && icon.Drawn, action + " does not carry the " + glyph + " glyph: " + (icon?.Kind ?? "none") + ".");
        }

        // The line's page: its words, and "n of N" where the speaker line sits.
        private static void Line(TaskPresentationValidation.Fixture f, string when, string words, string count)
        {
            Settle(f);
            Require(f.Strip.gameObject.activeInHierarchy && f.Strip.VisibleText.Contains(words), when + ": the line shows \"" + f.Strip.VisibleText + "\", not \"" + words + "\".");
            Require(f.Strip.SpeakerText.EndsWith(" · " + count, StringComparison.Ordinal), when + ": the speaker line reads \"" + f.Strip.SpeakerText + "\", not \"" + count + "\".");
        }

        // A pinch on the line's panel shows its next page.
        private static void Page(TaskPresentationValidation.Fixture f)
        {
            Settle(f);
            var backing = f.Strip.GetComponentsInChildren<MeshRenderer>(true).Single(renderer => renderer.name == "Speech contrast backing");
            var ray = new Ray(f.Eyes.position, backing.bounds.center - f.Eyes.position);
            Require(f.Strip.HitPage(ray), "A pinch on the line's panel does not page it.");
            f.Strip.NextPage();
        }

        // A pinch on the card or the sheet shows its next page.
        private static void CardPage(TaskPresentationValidation.Fixture f) => PanelPage(f, "Evidence instrument");
        private static void SheetPage(TaskPresentationValidation.Fixture f) => PanelPage(f, "Comfort options");
        private static void PanelPage(TaskPresentationValidation.Fixture f, string name)
        {
            Settle(f);
            var panel = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == name);
            var ray = new Ray(f.Eyes.position, panel.transform.position - f.Eyes.position);
            Require(f.Console.HitPage(ray), "A pinch on " + name + " does not page it.");
            f.Console.NextPage();
        }

        private static void Count(TaskPresentationValidation.Fixture f, string when, string name, string count)
        {
            Settle(f);
            var panel = f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == name);
            Require(panel.gameObject.activeInHierarchy && panel.StateText.EndsWith(" · " + count, StringComparison.Ordinal),
                when + ": the panel's top line reads \"" + panel.StateText + "\", not \"" + count + "\".");
        }

        private static void OpenContext(TaskPresentationValidation.Fixture f)
        {
            f.Console.Activate(ConsoleAction.More);
            f.Console.Activate(ConsoleAction.Options);
        }

        private static SpatialSurface Sheet(TaskPresentationValidation.Fixture f) =>
            f.Console.GetComponentsInChildren<SpatialSurface>(true).Single(surface => surface.name == "Comfort options");

        // The synthetic session: Boopy's line with two follow-ups, or a choice of two.
        private static SessionView View(bool choice = false)
        {
            var view = TaskPresentationValidation.Session(choice: choice);
            view.SpeechOutputAvailable = true;
            return view;
        }

        private static void Apply(TaskPresentationValidation.Fixture f, SessionView view)
        {
            Invoke(f.App, "Apply", view);
            Settle(f);
        }

        private static void Settle(TaskPresentationValidation.Fixture f) => ControlGrammarValidation.Settle(f);
        private static SpatialAction Control(TaskPresentationValidation.Fixture f, ConsoleAction action) =>
            f.Console.GetComponentsInChildren<SpatialAction>(true).Single(control => control.Action == action && control.GetComponentInParent<DialogueStrip>(true) == null);
        private static object? Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags)!.Invoke(target, args);
        private static object? Get(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target);
        private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
