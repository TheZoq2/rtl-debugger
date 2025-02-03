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
        if (message.type === 'cxxrtl_sc_message') {
            await libsurfer.on_cxxrtl_sc_message(message.message.inner);
        } else if (message.type === 'wcp_cs_message') {
            await libsurfer.handle_wcp_cs_message(message.message);
        } else {
            console.error('[RTL Debugger] [surferEmbed] Unhandled extension to webview message', message);
        }
    });

    const handle_cxxrtl_cs_messages = async () => {
        while (true) {
            const message = await libsurfer.cxxrtl_cs_message();
            if (message) {
                postMessage({type: 'cxxrtl_cs_message', message: new ClientPacketString(message)});
            } else {
                throw Error('Got an undefined message from Surfer. Its client probably disconnected');
            }
        }
    };

    const handle_wcp_sc_messages = async () => {
        while (true) {
            const message = await libsurfer.next_wcp_sc_message();
            if (message) {
                postMessage({type: 'wcp_sc_message', message: message});
            } else {
                throw Error('Got an undefined message from Surfer. Its client probably disconnected');
            }
        }
    };

    try {
        await libsurferInit();
        await new libsurfer.WebHandle().start(canvas);

        handle_cxxrtl_cs_messages();
        handle_wcp_sc_messages();

        await libsurfer.start_cxxrtl();
        await libsurfer.start_wcp();

        libsurferInjectMessage('ToggleMenu'); // turn off menu
        libsurferInjectMessage('ToggleStatusbar'); // turn off status bar
        libsurferInjectMessage('ToggleSidePanel');
        libsurferInjectMessage({ SelectTheme: 'dark+' }); // pick VS Code like theme

        overlay.style.display = 'none';
        postMessage({ type: 'ready' });
    } catch (error) {
        overlay.innerHTML = `Could not start Surfer waveform viewer.<br><br>Cause: ${error}`;
        postMessage({ type: 'crash', error });
    }
});
