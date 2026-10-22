using System.Linq;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class ContextReviewTests
    {
        private static Item Grounded(string id, bool emphasis = false, string kind = "object",
            string status = "proposed") => new Item
        {
            Id = id, Kind = kind, Status = status, Emphasis = emphasis,
            Grounding = new Grounding { Kind = "box", ObservationId = "synthetic-observation",
                Box = new Box2 { X0 = 0.1f, Y0 = 0.2f, X1 = 0.3f, Y1 = 0.4f } },
        };

        [TestCase("proposed", "ignore")]
        [TestCase("confirmed", "ignore")]
        [TestCase("ignored", "reset")]
        [TestCase("rejected", "reset")]
        public void InclusionNeverSilentlyConfirmsAModelClaim(string status, string action)
        {
            var item = Grounded("synthetic-selection", status: status);
            Assert.That(ContextReview.InclusionAction(item), Is.EqualTo(action));
            Assert.That(item.Status, Is.EqualTo(status));
        }

        [Test]
        public void CapsWorldAnnotationsAndPrioritizesOnlyReferentThenExplicitEmphasis()
        {
            var view = new SessionView { ReferentId = "subject" };
            view.Items.AddRange(new[] { Grounded("first"), Grounded("important", true),
                Grounded("subject"), Grounded("second"), Grounded("also-important", true) });
            Assert.That(ContextReview.WorldItems(view).Select(item => item.Id),
                Is.EqualTo(new[] { "subject", "important", "also-important" }));
            Assert.That(ContextReview.WorldItems(view, 5).Select(item => item.Id),
                Is.EqualTo(new[] { "subject", "important", "also-important", "first", "second" }));
            Assert.That(ContextReview.WorldItems(view, 0), Is.Empty);
            Assert.That(ContextReview.WorldItems(view, -1), Is.Empty);
        }

        [Test]
        public void KeepsSceneIdeasQuestionsAndSetAsideEvidenceInReaderOnly()
        {
            var intent = Grounded("intent", kind: "goal");
            var scene = new Item { Id = "scene-topic", Kind = "topic", Grounding = new Grounding { Kind = "scene" } };
            var question = Grounded("question", kind: "question");
            var ignored = Grounded("ignored", status: "ignored");
            var rejected = Grounded("rejected", status: "rejected");
            var view = new SessionView { IntentId = intent.Id, ReferentId = rejected.Id };
            view.Items.AddRange(new[] { intent, scene, question, ignored, rejected, Grounded("visible") });
            var reader = new EvidenceNavigator();
            reader.SetItems(view.Items);
            Assert.That(ContextReview.WorldItems(view).Select(item => item.Id), Is.EqualTo(new[] { "visible" }));
            Assert.That(reader.ItemCount, Is.EqualTo(5), "presentation omission does not discard reader evidence");
            foreach (var item in new[] { scene, question, ignored, rejected })
            {
                reader.Select(item.Id);
                Assert.That(reader.Selected, Is.SameAs(item));
            }
        }

        [Test]
        public void RequiresActualAttributedBoxOrPointWithoutInventingUnknownGeometry()
        {
            var point = new Item { Id = "point", Grounding = new Grounding { Kind = "point",
                ObservationId = "synthetic-observation", Point = new Point2 { X = 0.4f, Y = 0.5f } } };
            var missingBox = Grounded("missing-box");
            missingBox.Grounding.Box = null;
            var missingObservation = Grounded("unattributed");
            missingObservation.Grounding.ObservationId = null;
            var view = new SessionView();
            view.Items.AddRange(new[] { missingBox, missingObservation, point });
            Assert.That(ContextReview.WorldItems(view).Single(), Is.SameAs(point));
            Assert.That(missingBox.Grounding.Box, Is.Null);
            Assert.That(missingObservation.Grounding.ObservationId, Is.Null);
        }

        [Test]
        public void PresentationSelectionNeverMutatesItemsOrTurnsProposalIntoConfirmation()
        {
            var proposal = Grounded("proposal");
            proposal.Confidence = 0.2f;
            var confirmed = Grounded("confirmed", status: "confirmed");
            var view = new SessionView { ReferentId = proposal.Id };
            view.Items.AddRange(new[] { confirmed, proposal, Grounded("third"), Grounded("fourth") });
            var original = view.Items.ToArray();
            var before = Wire.Write(view);
            var visible = ContextReview.WorldItems(view);
            Assert.That(visible[0], Is.SameAs(proposal));
            Assert.That(proposal.Status, Is.EqualTo("proposed"));
            Assert.That(proposal.Confidence, Is.EqualTo(0.2f));
            Assert.That(view.Items, Is.EqualTo(original));
            Assert.That(Wire.Write(view), Is.EqualTo(before));
            var reader = new EvidenceNavigator();
            reader.SetItems(view.Items);
            Assert.That(reader.ItemCount, Is.EqualTo(4));
        }

        [Test]
        public void DoesNotOfferSaveForFailedInterpretationOrAnAlreadyCommittedPackage()
        {
            var view = new SessionView();
            view.Items.Add(new Item { Origin = "person", Status = "confirmed" });
            Assert.That(ContextReview.CanSave(view), Is.False, "an authored note cannot disguise model failure");
            view.Model = new ModelRef { Provider = "fixture", Id = "synthetic" };
            Assert.That(ContextReview.CanSave(view), Is.True);
            view.State = "committed";
            view.Committed = new Committed { PackageId = "synthetic-package" };
            Assert.That(ContextReview.CanSave(view), Is.False);
            Assert.That(ContextReview.Receipt(view), Is.EqualTo("Context ready on your Mac · Not sent yet"));
        }

        private static SessionView SpokenContext()
        {
            const string words = "It felt Much Colder. 그 여행은 추웠어요.";
            var view = new SessionView { Id = "synthetic-spoken-session",
                Attention = new AttentionView { UtteranceId = "synthetic-utterance", Action = "no-visual-work", Source = "unknown" } };
            view.Utterances.Add(new UtteranceRef { Id = "synthetic-utterance", Text = words, Kind = "ask" });
            view.Items.Add(new Item { Id = "synthetic-authored-item", Kind = "utterance", Origin = "person",
                Status = "confirmed", Confidence = null, Statement = words, Grounding = new Grounding { Kind = "scene" } });
            return view;
        }

        [Test]
        public void CompletedSpokenContextCanSaveWithoutInventingModelOrSpatialEvidence()
        {
            var view = SpokenContext();
            var before = Wire.Write(view);
            Assert.That(ContextReview.CanSave(view), Is.True);
            Assert.That(ContextReview.Evidence(view.Items[0]), Is.EqualTo(view.Utterances[0].Text));
            Assert.That(ContextReview.SaveSummary(view), Does.StartWith("Prepare these words, corrections and selected details for your agent."));
            Assert.That(ContextReview.SaveSummary(view), Does.Not.Contain("Model suggestions").And.Not.Contain("Open questions"));
            Assert.That(ContextReview.SaveSummary(view), Does.Contain("Nothing is sent."));
            Assert.That(ContextReview.WorldItems(view), Is.Empty);
            Assert.That(view.Model, Is.Null);
            Assert.That(view.Items[0].Confidence, Is.Null);
            Assert.That(Wire.Write(view), Is.EqualTo(before));
        }

        [Test]
        public void ActualCompletedAuthoringSurvivesClearedOrStaleAttentionAndLaterVisualFailure()
        {
            var view = SpokenContext();
            view.Attention = null;
            Assert.That(ContextReview.CanSave(view), Is.True, "direct person actions clear attention");
            view.Attention = new AttentionView { UtteranceId = "old-utterance", Action = "fresh-view" };
            view.Utterances.Add(new UtteranceRef { Id = "later-utterance", Text = "Inspect the new view.", Kind = "ask" });
            view.Notice = "Could not interpret that. Please try again.";
            Assert.That(ContextReview.CanSave(view), Is.True, "earlier authored evidence remains useful without claiming later model success");
            view.Items[0].Status = "ignored";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view.Items[0].Status = "confirmed"; // Service reset preserves person-origin authoring.
            Assert.That(ContextReview.CanSave(view), Is.True);
            view.Items[0].Statement = "The person corrected their recollection.";
            Assert.That(ContextReview.CanSave(view), Is.True);
        }

        [TestCase("ignored")]
        [TestCase("rejected")]
        [TestCase("known")]
        public void ExcludedOrSetAsideOnlySpokenContextDoesNotOfferSave(string status)
        {
            var view = SpokenContext(); view.Items[0].Status = status;
            Assert.That(ContextReview.CanSave(view), Is.False);
        }

        [Test]
        public void MissingRecordedSpeechEmptyStatementOrGenericNotesCannotFakeSpokenCompletion()
        {
            var view = SpokenContext(); view.Utterances.Clear();
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Utterances[0].Text = "   ";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Utterances[0].Id = "";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Items[0].Statement = "   ";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Items[0].Kind = "note";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Items[0].Origin = "model";
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Items[0].Confidence = 1f;
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Items.Clear();
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.Committed = new Committed { PackageId = "synthetic" };
            Assert.That(ContextReview.CanSave(view), Is.False);
            view = SpokenContext(); view.State = "committed";
            Assert.That(ContextReview.CanSave(view), Is.False);
        }

        [Test]
        public void SavePreviewExplainsContentsWithoutConfirmingOrClaimingDelivery()
        {
            var view = new SessionView { IntentId = "goal" };
            view.Items.Add(new Item { Id = "goal", Kind = "goal", Status = "proposed", Origin = "model" });
            view.Items.Add(Grounded("a"));
            view.Items.Add(Grounded("b", status: "confirmed"));
            view.Items.Add(Grounded("skip", status: "ignored"));
            view.Items.Add(Grounded("rejected", status: "rejected"));
            view.Items.Add(new Item { Id = "q", Kind = "question", Status = "proposed" });
            var before = Wire.Write(view);
            var summary = ContextReview.SaveSummary(view);
            Assert.That(summary, Does.StartWith("Prepare these words, corrections and selected details for your agent."));
            Assert.That(summary, Does.Contain("Model suggestions stay unconfirmed.").And.Contain("Open questions stay open."));
            Assert.That(summary, Does.Contain("Nothing is sent."));
            Assert.That(Wire.Write(view), Is.EqualTo(before));
        }

        [Test]
        public void ConversationSummaryUsesExistingContextWithoutUpgradingProposals()
        {
            var view = new SessionView { IntentId = "goal" };
            view.Items.Add(new Item { Id = "goal", Label = "Do not repeat goal" });
            view.Items.Add(new Item { Id = "reply", Label = "Suggested answer" });
            view.Items.Add(new Item { Id = "excluded", Status = "ignored", Label = "Excluded" });
            view.Items.Add(new Item { Id = "claim", Origin = "model", Status = "proposed", Label = "Possible desert" });
            view.Items.Add(new Item { Id = "account", Origin = "person", Status = "confirmed", Label = "It felt cold" });
            view.Items.Add(new Item { Id = "question", Origin = "model", Status = "proposed", Kind = "question", Label = "Where was this?" });
            view.Items.Add(new Item { Id = "extra", Origin = "model", Status = "proposed", Label = "Another detail" });
            var before = Wire.Write(view);
            var summary = ContextReview.ConversationSummary(view);
            Assert.That(summary, Does.Contain("Proposed · Possible desert").And.Contain("You said · It felt cold").And.Contain("Open question · Where was this?"));
            Assert.That(summary, Does.Contain("1 more detail").And.Not.Contain("Excluded").And.Not.Contain("Suggested answer").And.Not.Contain("Do not repeat goal"));
            Assert.That(Wire.Write(view), Is.EqualTo(before));
        }

        [Test]
        public void ShowsOcrAsWrittenInsteadOfReplacingItWithModelText()
        {
            var item = new Item
            {
                Statement = "a corrected paraphrase",
                Text = new System.Collections.Generic.List<string> { "사막 메모" },
                Why = "synthetic model explanation",
                Note = "synthetic person note",
            };
            var evidence = ContextReview.Evidence(item);
            Assert.That(evidence, Does.StartWith("OCR as written: 사막 메모"));
            Assert.That(evidence, Does.Not.Contain("corrected paraphrase"));
            Assert.That(evidence, Does.Contain("Model explanation: synthetic model explanation"));
            Assert.That(evidence, Does.Contain("You said: synthetic person note"));
        }

        [Test]
        public void KeepsModelProposalsSeparateFromHumanConfirmationInCounts()
        {
            var view = new SessionView();
            view.Items.Add(new Item { Status = "proposed", Confidence = 1f });
            view.Items.Add(new Item { Status = "confirmed", Origin = "person" });
            view.Items.Add(new Item { Status = "known" });
            Assert.That(ContextReview.Counts(view), Is.EqualTo("1 proposed · 1 confirmed · 1 known · 0 questions"));
            Assert.That(ContextReview.Receipt(view), Is.EqualTo("Context not prepared"));
        }
    }
}
