// Copy of the Streamybox embedded renderer contract (identical in dev.streamybox.player).
package dev.streamybox.player.render;

import dev.streamybox.player.render.IRenderCallback;

interface IRenderService {
    /** Contract version, currently 1. */
    int apiVersion();
    /** Starts a session; returns a session id (>0). */
    int attach(IRenderCallback callback);
    void setSurface(int session, in Surface surface, int width, int height);
    /** Surface destroyed (SurfaceView detached / app backgrounded). Playback pauses, decoding stops. */
    void clearSurface(int session);
    /** optionsJson: {"title":String?, "startPositionMs":Long?, "headers":[String]?, "muted":Boolean?,
     *  "audioTrack":Int?, "subtitleTrack":Int? (-1 = off), "externalSubtitles":[{"url","title","language"}]?} */
    void load(int session, String url, String optionsJson);
    void play(int session);
    void pause(int session);
    void seek(int session, long positionMs);
    /** mpv track ids (`aid`/`sid`) as reported in the `tracks` event; -1 subtitle = off. */
    void setAudioTrack(int session, int id);
    void setSubtitleTrack(int session, int id);
    void setMuted(int session, boolean muted);
    /** Stops playback and releases decoders; the session stays attached. */
    void stop(int session);
    void detach(int session);
}
