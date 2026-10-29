// Streamybox embedded renderer contract v1. Keep identical in dev.streamybox.player and Streamarr.
package dev.streamybox.player.render;

oneway interface IRenderCallback {
    /** One JSON event, see "Events". */
    void onEvent(String json);
}
