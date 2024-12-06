import * as vscode from 'vscode';

import { CXXRTLDebugger } from '../debugger';
// @ts-ignore
import embedHtml from '../surfer/embed.html';
import { ILink, Packet } from '../cxxrtl/link';
import { ClientPacket } from '../cxxrtl/proto';

export class ClientPacketString {
    constructor(public inner: string) { }
}
export class ServerPacketString {
    constructor(public inner: string) { }
}


export type ExtensionToWebviewMessage =
  | { type: 'restore', state: any }
  // TODO: Proper type here
  | { type: 'cxxrtl_scmessage', message: ServerPacketString }
  ;

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'crash', error: any }
  // TODO: Proper type here
  | { type: 'cxxrtl_csmessage', message: ClientPacketString }
  ;

export class WaveformProvider {
    constructor(
        private rtlDebugger: CXXRTLDebugger,
        private webviewPanel: vscode.WebviewPanel,
        bundleRoot: vscode.Uri,
    ) {
        const webviewHtml = embedHtml.replace(/__base_href__/,
            this.webview.asWebviewUri(bundleRoot).toString());
        this.webview.onDidReceiveMessage(this.processMessage.bind(this));
        this.webview.html = webviewHtml;
        const debuggerLink = rtlDebugger.session?.createSecondaryLink();

        // TODO: Correct way to handle errors?
        if (debuggerLink) {
            this.debuggerLink = debuggerLink;
            this.debuggerLink.onRecv = async (message) => {
                // console.log("Running on recv for ", message)
                await this.sendMessage({ type: "cxxrtl_scmessage", message: new ServerPacketString(message.asString()) })
            };
        } else {
            throw new Error('Failed to create secondary debugger link');
        }
    }

    dispose() {
        this.webviewPanel.dispose();
    }

    get webview() {
        return this.webviewPanel.webview;
    }

    private async sendMessage(message: ExtensionToWebviewMessage) {
        const messagePosted = await this.webview.postMessage(message);
        if (!messagePosted) {
            console.warn('[RTL Debugger] [WaveformProvider] Dropping extension to webview message:', message);
        }
    }

    private async processMessage(message: WebviewToExtensionMessage) {
        if (message.type === 'ready') {
            console.log('[RTL Debugger] [WaveformProvider] Ready');
        } else if (message.type === 'crash') {
            console.log('[RTL Debugger] [WaveformProvider] Crash:', message.error);
        } else if (message.type == 'cxxrtl_csmessage') {
            console.log('[RTL Debugger] [WaveformProvider] Got CSMessage', message.message);
            const packet: Packet<ClientPacket> = Packet.fromString(message.message.inner);
            await this.debuggerLink.send(packet);
        } else {
            console.error('[RTL Debugger] [WaveformProvider] Unhandled webview to extension message:', message);
        }
    }

    private debuggerLink: ILink;
}
