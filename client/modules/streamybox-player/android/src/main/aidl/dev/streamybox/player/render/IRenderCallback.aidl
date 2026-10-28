// Copy of the Streamybox embedded renderer contract (identical in dev.streamybox.player).
package dev.streamybox.player.render;

oneway interface IRenderCallback {
    /** One JSON event, see "Events". */
    void onEvent(String json);
}
