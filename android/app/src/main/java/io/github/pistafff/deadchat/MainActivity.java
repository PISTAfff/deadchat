package io.github.pistafff.deadchat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EarpiecePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
