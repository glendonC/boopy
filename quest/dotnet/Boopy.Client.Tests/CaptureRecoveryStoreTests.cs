using System;
using System.IO;
using System.Linq;
using System.Text;
using Boopy.Client;
using NUnit.Framework;

namespace Boopy.Client.Tests;

public class CaptureRecoveryStoreTests
{
    private string directory = null!;
    private string path = null!;
    private const string Id = "0623e688-d50a-4491-b5c4-7d5ee3ee6912";
    [SetUp] public void SetUp()
    {
        directory = Path.Combine(Path.GetTempPath(), "boopy-recovery-test-" + Guid.NewGuid().ToString("N"));
        path = Path.Combine(directory, "pending");
    }
    [TearDown] public void TearDown() { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    [Test] public void RestartLoadsOnlyExactUuidAndReplacementLeavesNoTemporaryContent()
    {
        Assert.That(new CaptureRecoveryStore(path).Load(), Is.Null);
        new CaptureRecoveryStore(path).Save(Id);
        Assert.That(new CaptureRecoveryStore(path).Load(), Is.EqualTo(Id));
        Assert.That(File.ReadAllBytes(path), Is.EqualTo(Encoding.ASCII.GetBytes(Id)));
        var next = Guid.NewGuid().ToString("D");
        new CaptureRecoveryStore(path).Save(next);
        Assert.That(new CaptureRecoveryStore(path).Load(), Is.EqualTo(next));
        Assert.That(Directory.GetFiles(directory).Select(Path.GetFileName), Is.EqualTo(new[] { "pending" }));
    }
    [TestCase("")]
    [TestCase("not-a-request")]
    [TestCase("0623E688-D50A-4491-B5C4-7D5EE3EE6912")]
    [TestCase("0623e688-d50a-4491-b5c4-7d5ee3ee6912\n")]
    [TestCase("{0623e688-d50a-4491-b5c4-7d5ee3ee6912}")]
    public void InvalidSavePreservesExistingRecord(string invalid)
    {
        var store = new CaptureRecoveryStore(path); store.Save(Id);
        Assert.Throws<InvalidDataException>(() => store.Save(invalid));
        Assert.That(store.Load(), Is.EqualTo(Id));
    }
    [TestCase("garbage")]
    [TestCase("")]
    [TestCase("0623e688-d50a-4491-b5c4-7d5ee3ee6912\n")]
    public void MalformedLoadThrowsAndDoesNotRewrite(string record)
    {
        Directory.CreateDirectory(directory); File.WriteAllText(path, record);
        Assert.Throws<InvalidDataException>(() => new CaptureRecoveryStore(path).Load());
        Assert.That(File.ReadAllText(path), Is.EqualTo(record));
    }
    [Test] public void OversizedAndMalformedUtf8AreRejectedWithoutRewrite()
    {
        Directory.CreateDirectory(directory);
        foreach (var bytes in new[] { new byte[129], new byte[] { 0xff, 0xfe } })
        {
            File.WriteAllBytes(path, bytes);
            Assert.Catch(() => new CaptureRecoveryStore(path).Load());
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(bytes));
        }
    }
    [Test] public void FailedPublicationThrowsAndCleansTemporaryRecord()
    {
        Directory.CreateDirectory(path); // Destination is not a replaceable file.
        Assert.Catch(() => new CaptureRecoveryStore(path).Save(Id));
        Assert.That(Directory.GetFiles(directory), Is.Empty);
        Assert.That(Directory.Exists(path), Is.True);
    }
    [Test] public void ClearIsIdempotentEvenBeforeDirectoryExists()
    {
        var store = new CaptureRecoveryStore(path); store.Clear(); store.Save(Id);
        store.Clear(); store.Clear(); Assert.That(store.Load(), Is.Null);
    }
}
