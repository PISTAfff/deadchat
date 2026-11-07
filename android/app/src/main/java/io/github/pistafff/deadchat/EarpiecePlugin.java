package io.github.pistafff.deadchat;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Voice notes held to the ear: the proximity sensor reports near/far, and while near the note
// plays here as voice-call audio, which Android sends to the earpiece (a web page's audio
// always goes to the loudspeaker). The screen goes dark while the phone is at the ear.
@CapacitorPlugin(name = "Earpiece")
public class EarpiecePlugin extends Plugin implements SensorEventListener {
    private SensorManager sensors;
    private Sensor proximity;
    private boolean listening = false;
    private boolean near = false;
    private PowerManager.WakeLock screenOff;
    private MediaPlayer player;
    private AudioManager audio;

    @Override
    public void load() {
        Context ctx = getContext();
        sensors = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        proximity = sensors != null ? sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY) : null;
        audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
            screenOff = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "deadchat:ear");
            screenOff.setReferenceCounted(false);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (proximity != null && !listening) {
            sensors.registerListener(this, proximity, SensorManager.SENSOR_DELAY_NORMAL);
            listening = true;
        }
        if (screenOff != null && !screenOff.isHeld()) screenOff.acquire(60 * 60 * 1000L);
        JSObject r = new JSObject();
        r.put("available", proximity != null);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopListening();
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        String path = call.getString("path");
        double position = call.getDouble("position", 0.0);
        float rate = call.getFloat("rate", 1f);
        if (path == null) { call.reject("path missing"); return; }
        release();
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            mp.setDataSource(getContext(), Uri.parse(path));
            mp.prepare();
            toEarpiece(true);
            mp.seekTo((int) Math.round(position * 1000));
            if (Build.VERSION.SDK_INT >= 23 && rate != 1f) {
                PlaybackParams p = mp.getPlaybackParams();
                p.setSpeed(rate);
                mp.setPlaybackParams(p);
            }
            mp.setOnCompletionListener(done -> {
                release();
                notifyListeners("ended", new JSObject());
            });
            mp.start();
            player = mp;
            call.resolve();
        } catch (Exception e) {
            release();
            call.reject("Could not play at the ear: " + e.getMessage());
        }
    }

    @PluginMethod
    public void position(PluginCall call) {
        JSObject r = new JSObject();
        r.put("position", player != null ? player.getCurrentPosition() / 1000.0 : -1);
        r.put("playing", player != null && player.isPlaying());
        call.resolve(r);
    }

    // stop playing at the ear and say where it got to, so the page carries on from there
    @PluginMethod
    public void halt(PluginCall call) {
        double pos = player != null ? player.getCurrentPosition() / 1000.0 : -1;
        release();
        JSObject r = new JSObject();
        r.put("position", pos);
        call.resolve(r);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        boolean now = e.values[0] < Math.min(5f, proximity.getMaximumRange());
        if (now == near) return;
        near = now;
        JSObject r = new JSObject();
        r.put("near", near);
        notifyListeners("proximity", r);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (player == null) stopListening();
    }

    @Override
    protected void handleOnDestroy() {
        release();
        stopListening();
        super.handleOnDestroy();
    }

    private void stopListening() {
        if (listening) sensors.unregisterListener(this);
        listening = false;
        near = false;
        if (screenOff != null && screenOff.isHeld()) screenOff.release();
    }

    private void toEarpiece(boolean on) {
        if (audio == null) return;
        if (on) {
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) { audio.setCommunicationDevice(d); break; }
                }
            } else {
                audio.setSpeakerphoneOn(false);
            }
        } else {
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
            audio.setMode(AudioManager.MODE_NORMAL);
        }
    }

    private void release() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
        toEarpiece(false);
    }
}
