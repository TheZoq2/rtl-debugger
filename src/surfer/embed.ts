import libsurferInit, * as libsurfer from 'libsurfer';

import { ClientPacketString, type ExtensionToWebviewMessage, type WebviewToExtensionMessage } from '../ui/waveform';

function libsurferInjectMessage(message: any) {
    libsurfer.inject_message(JSON.stringify(message));
}


document.addEventListener('DOMContentLoaded', async () => {
    const vscode = acquireVsCodeApi();
    const canvas = <HTMLCanvasElement>document.getElementById('canvas');
    const overlay = <HTMLDivElement>document.getElementById('overlay');

    canvas.height = canvas.clientHeight;
    canvas.width = canvas.clientWidth;
    canvas.addEventListener('resize', () => {
        canvas.height = canvas.clientHeight;
        canvas.width = canvas.clientWidth;
    });

    const postMessage = <(message: WebviewToExtensionMessage) => void>vscode.postMessage;
    window.addEventListener('message', async (event: MessageEvent<ExtensionToWebviewMessage>) => {
        const message = event.data;
        if (message.type === 'cxxrtl_scmessage') {
            console.log("Handing off ", message.message.inner, " to Surfer")
            await libsurfer.on_cxxrtl_sc_message(message.message.inner);
        } else {
            console.error('[RTL Debugger] [surferEmbed] Unhandled extension to webview message', message);
        }
    });

    const handle_cs_messages = async () => {
        while (true) {
            const message = await libsurfer.cxxrtl_cs_message();
            if (message) {
                postMessage({type: 'cxxrtl_csmessage', message: new ClientPacketString(message)});
            } else {
                throw Error('Got an undefined message from Surfer. Its client probably disconnected');
            }
        }
    };

    try {
        await libsurferInit();
        await new libsurfer.WebHandle().start(canvas);

        handle_cs_messages();

        await libsurfer.start_cxxrtl();

        libsurferInjectMessage('ToggleMenu'); // turn off menu
        // libsurferInjectMessage('ToggleStatusBar'); // turn off status bar
        // libsurferInjectMessage('ToggleSidePanel');
        libsurferInjectMessage({ SelectTheme: 'dark+' }); // pick VS Code like theme

        overlay.style.display = 'none';
        postMessage({ type: 'ready' });
    } catch (error) {
        overlay.innerHTML = `Could not start Surfer waveform viewer.<br><br>Cause: ${error}`;
        postMessage({ type: 'crash', error });
    }
});
