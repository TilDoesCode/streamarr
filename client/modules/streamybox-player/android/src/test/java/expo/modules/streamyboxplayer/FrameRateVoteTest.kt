package expo.modules.streamyboxplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameRateVoteTest {
  @Test
  fun snapsToTheBroadcastRateItMeans() {
    assertEquals(23.976f, FrameRateVote.snap(23.976), 0f)
    assertEquals(23.976f, FrameRateVote.snap(24000.0 / 1001), 0f)
    assertEquals(24f, FrameRateVote.snap(24.0), 0f)
    assertEquals(25f, FrameRateVote.snap(25.02), 0f)
    assertEquals(29.97f, FrameRateVote.snap(29.97003), 0f)
    assertEquals(59.94f, FrameRateVote.snap(59.94006), 0f)
  }

  @Test
  fun keepsOtherRatesAndRejectsNonsense() {
    assertEquals(48f, FrameRateVote.snap(48.0), 0f)
    assertEquals(0f, FrameRateVote.snap(0.0), 0f)
    assertEquals(0f, FrameRateVote.snap(-24.0), 0f)
    assertEquals(0f, FrameRateVote.snap(Double.NaN), 0f)
    assertEquals(0f, FrameRateVote.snap(Double.POSITIVE_INFINITY), 0f)
  }

  @Test
  fun playerRateWinsOverTheServerProbe() {
    val vote = FrameRateVote()
    vote.load(24.0)
    assertEquals(24f, vote.rate, 0f)
    assertEquals("server", vote.source)
    vote.tracks(23.976)
    assertEquals(23.976f, vote.rate, 0f)
    assertEquals("player", vote.source)
  }

  @Test
  fun tracksWithoutRateKeepTheLoadsRate() {
    val vote = FrameRateVote()
    vote.load(0.0)
    vote.tracks(23.976)
    vote.tracks(0.0)
    vote.tracks(Double.NaN)
    assertEquals(23.976f, vote.rate, 0f)
  }

  @Test
  fun aNewLoadDropsThePreviousFilesRate() {
    val vote = FrameRateVote()
    vote.load(0.0)
    vote.tracks(23.976)
    vote.sent(vote.rate)
    vote.load(0.0)
    assertEquals(0f, vote.rate, 0f)
    assertEquals("none", vote.source)
    assertEquals(0f, vote.pending())
  }

  @Test
  fun sendsOnlyWhatTheSurfaceDoesNotHaveYet() {
    val vote = FrameRateVote()
    assertNull(vote.pending())
    vote.load(23.976)
    assertEquals(23.976f, vote.pending())
    vote.sent(23.976f)
    assertNull(vote.pending())
    vote.tracks(23.976)
    assertNull(vote.pending())
    vote.forget()
    assertEquals(23.976f, vote.pending())
  }

  @Test
  fun theEndClearsTheVote() {
    val vote = FrameRateVote()
    vote.load(25.0)
    vote.sent(25f)
    vote.end()
    assertEquals(0f, vote.pending())
    vote.sent(0f)
    assertNull(vote.pending())
  }

  @Test
  fun aFreshSurfaceWithoutRateNeedsNothing() {
    val vote = FrameRateVote()
    vote.load(0.0)
    vote.forget()
    assertNull(vote.pending())
  }
}
