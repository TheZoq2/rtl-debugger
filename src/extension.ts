import * as vscode from 'vscode';

import { CXXRTLDebugger } from './debugger';
import * as sidebar from './ui/sidebar';
import { globalWatchList } from './debug/watch';
import { globalVariableOptions } from './debug/options';
import { HoverProvider } from './ui/hover';
import { DiagnosticProvider } from './ui/diagnostic';
import { inputTime } from './ui/input';
import { WaveformProvider } from './ui/waveform';

export function activate(context: vscode.ExtensionContext) {
    const rtlDebugger = new CXXRTLDebugger();

    console.log('Attached');

    const sidebarTreeDataProvider = new sidebar.TreeDataProvider(rtlDebugger);
    const sidebarTreeView = vscode.window.createTreeView('rtlDebugger.sidebar', {
        treeDataProvider: sidebarTreeDataProvider
    });
    context.subscriptions.push(sidebarTreeView);

    const hoverProvider = new HoverProvider(rtlDebugger);
    for (const language of HoverProvider.SUPPORTED_LANGUAGES) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(language, hoverProvider));
    }

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('rtlDebugger');
    const diagnosticProvider = new DiagnosticProvider(rtlDebugger, diagnosticCollection);
    context.subscriptions.push(diagnosticProvider);

    vscode.commands.executeCommand('setContext', 'rtlDebugger.sessionStatus', rtlDebugger.sessionStatus);
    context.subscriptions.push(rtlDebugger.onDidChangeSessionStatus((state) =>
        vscode.commands.executeCommand('setContext', 'rtlDebugger.sessionStatus', state)));

    vscode.commands.executeCommand('setContext', 'rtlDebugger.simulationStatus', rtlDebugger.simulationStatus);
    context.subscriptions.push(rtlDebugger.onDidChangeSimulationStatus((state) =>
        vscode.commands.executeCommand('setContext', 'rtlDebugger.simulationStatus', state)));

    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.startSession', () =>
        rtlDebugger.startSession()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.stopSession', () =>
        rtlDebugger.stopSession()));
    context.subscriptions.push({ dispose: () => rtlDebugger.stopSession() });

    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.runSimulation', () =>
        rtlDebugger.session!.runSimulation()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.pauseSimulation', () =>
        rtlDebugger.session!.pauseSimulation()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.runPauseSimulation', () => {
        if (rtlDebugger.session!.isSimulationRunning) {
            rtlDebugger.session!.pauseSimulation();
        } else {
            rtlDebugger.session!.runSimulation();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.runSimulationUntil', async () => {
        const untilTime = await inputTime({ prompt: 'Enter the time to simulate until.' });
        if (untilTime !== undefined) {
            rtlDebugger.session!.runSimulation({ untilTime });
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.stepBackward', () =>
        rtlDebugger.session!.stepBackward()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.stepForward', () =>
        rtlDebugger.session!.stepForward()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.continueForward', () =>
        rtlDebugger.session!.continueForward()));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.goToTime', async () => {
        const goToTime = await inputTime({ prompt: 'Enter the time to examine the state at.' });
        if (goToTime !== undefined) {
            if (rtlDebugger.session!.simulationStatus.latestTime.lessThan(goToTime)) {
                vscode.window.showErrorMessage(`The simulation has not advanced to ${goToTime} yet.`);
            } else {
                rtlDebugger.session!.timeCursor = goToTime;
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.setRadix.2', (treeItem) =>
        globalVariableOptions.update(treeItem.designation.variable.cxxrtlIdentifier, { radix: 2 })));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.setRadix.8', (treeItem) =>
        globalVariableOptions.update(treeItem.designation.variable.cxxrtlIdentifier, { radix: 8 })));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.setRadix.10', (treeItem) =>
        globalVariableOptions.update(treeItem.designation.variable.cxxrtlIdentifier, { radix: 10 })));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.setRadix.16', (treeItem) =>
        globalVariableOptions.update(treeItem.designation.variable.cxxrtlIdentifier, { radix: 16 })));

    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.watchVariable', (treeItem) =>
        globalWatchList.append(treeItem.getWatchItem())));
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.unWatchVariable', (treeItem) =>
        globalWatchList.remove(treeItem.metadata.index)));


    console.log('Registering rtlDebugger.browseWaveforms');
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.browseWaveforms', () => {
        console.log('Running browseWaveforms');
        const webviewPanel = vscode.window.createWebviewPanel(
            'rtlDebugger.waveforms',
            'Waveforms', {
                viewColumn: vscode.ViewColumn.Beside,
            }, {
                enableScripts: true,
                retainContextWhenHidden: true,
            });
        const bundleRoot = vscode.Uri.joinPath(context.extensionUri, 'out/');
        context.subscriptions.push(new WaveformProvider(rtlDebugger, webviewPanel, bundleRoot));
    }));

    // For an unknown reason, the `vscode.open` command (which does the exact same thing) ignores the options.
    context.subscriptions.push(vscode.commands.registerCommand('rtlDebugger.openDocument',
        (uri: vscode.Uri, options: vscode.TextDocumentShowOptions) => {
            vscode.window.showTextDocument(uri, options);
        }));
}
