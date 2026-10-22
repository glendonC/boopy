#nullable enable
using System;
using System.IO;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests
{
    public class HandoffRecoveryStoreTests
    {
        private string directory = "";
        private string PathForRecord => Path.Combine(directory, "preparation-identity");
        [SetUp] public void Create() { directory = Path.Combine(Path.GetTempPath(), "boopy-handoff-id-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory); }
        [TearDown] public void Remove() { Directory.Delete(directory, true); }
        private static HandoffRecoveryRecord Record(string? packageId = null) => new HandoffRecoveryRecord {
            SessionId = "ses_synthetic", RequestId = "11111111-1111-4111-8111-111111111111", PackageId = packageId,
        };

        [Test]
        public void RecreatesPrecommitAndVerifiedPackageIdentityWithoutContentOrDeliveryState()
        {
            var store = new HandoffRecoveryStore(PathForRecord); Assert.That(store.Load(), Is.Null);
            store.Save(Record());
            var precommit = new HandoffRecoveryStore(PathForRecord).Load();
            Assert.That(precommit?.SessionId, Is.EqualTo("ses_synthetic"));
            Assert.That(precommit?.PackageId, Is.Null);
            var pending = Record("ctx_synthetic"); store.Save(pending);
            var completed = new HandoffRecoveryStore(PathForRecord).Load();
            Assert.That(completed?.RequestId, Is.EqualTo(pending.RequestId));
            Assert.That(completed?.PackageId, Is.EqualTo(pending.PackageId));
            var text = File.ReadAllText(PathForRecord);
            Assert.That(text, Is.EqualTo(Wire.Write(pending)));
            Assert.That(text, Does.Not.Contain("query").And.Not.Contain("packet").And.Not.Contain("frame").And.Not.Contain("prepared-local").And.Not.Contain("valid"));
            Assert.That(Directory.GetFiles(directory), Has.Length.EqualTo(1));
        }
        [Test]
        public void OnlyExplicitClearRemovesTheDurableAnchor()
        {
            var store = new HandoffRecoveryStore(PathForRecord); store.Save(Record("ctx_synthetic"));
            Assert.That(new HandoffRecoveryStore(PathForRecord).Load(), Is.Not.Null);
            store.Clear(); store.Clear(); Assert.That(store.Load(), Is.Null);
        }
        [TestCase("{}")]
        [TestCase("{malformed")]
        [TestCase("{\"sessionId\":\"ses_synthetic\",\"requestId\":\"11111111-1111-4111-8111-111111111111\",\"query\":\"never persist this\"}")]
        [TestCase("{\"sessionId\":\"ses_synthetic\",\"requestId\":\"11111111-1111-4111-8111-111111111111\",\"packageId\":\"ctx_valid\",\"packageId\":\"ctx_other\"}")]
        [TestCase("{\"sessionId\":\"../invalid\",\"requestId\":\"11111111-1111-4111-8111-111111111111\"}")]
        public void CorruptOrExpandedRecordsFailClosed(string text)
        {
            File.WriteAllText(PathForRecord, text);
            Assert.Catch(() => new HandoffRecoveryStore(PathForRecord).Load());
            Assert.That(File.Exists(PathForRecord), Is.True);
        }
        [Test]
        public void RejectsOversizedAndInvalidUtf8WithoutReplacingOrClearingEvidence()
        {
            File.WriteAllBytes(PathForRecord, new byte[1025]); Assert.Catch(() => new HandoffRecoveryStore(PathForRecord).Load());
            File.WriteAllBytes(PathForRecord, new byte[] { 255 }); Assert.Catch(() => new HandoffRecoveryStore(PathForRecord).Load());
        }
        [Test]
        public void InvalidReplacementLeavesThePreviousExactAnchorIntact()
        {
            var store = new HandoffRecoveryStore(PathForRecord); var valid = Record("ctx_synthetic"); store.Save(valid);
            var invalid = Record("ctx_other"); invalid.RequestId = "not-a-request-id";
            Assert.Catch(() => store.Save(invalid));
            Assert.That(store.Load()?.PackageId, Is.EqualTo(valid.PackageId));
            Assert.That(Directory.GetFiles(directory), Has.Length.EqualTo(1));
        }
        [Test]
        public void StorageFailureIsReportedAndDoesNotInventARecoveryRecord()
        {
            var fileParent = Path.Combine(directory, "not-a-directory"); File.WriteAllText(fileParent, "synthetic");
            var store = new HandoffRecoveryStore(Path.Combine(fileParent, "identity"));
            Assert.Catch(() => store.Save(Record()));
            Assert.That(File.ReadAllText(fileParent), Is.EqualTo("synthetic"));
        }
    }
}
