import * as vscode from 'vscode';

import * as proto from '../cxxrtl/proto';
import { ILink } from '../cxxrtl/link';
import { Connection } from '../cxxrtl/client';
import { TimeInterval, TimePoint } from '../model/time';
import { Diagnostic, DiagnosticType, Reference, Sample, UnboundReference } from '../model/sample';
import { Variable } from '../model/variable';
import { Scope } from '../model/scope';
import { Location } from '../model/source';

function lazy<T>(thunk: () => Thenable<T>): Thenable<T> {
    return { then: (onfulfilled, onrejected) => thunk().then(onfulfilled, onrejected) };
}

function matchLocation(location: Location, filename: string, position: vscode.Position) {
    if (location.file !== filename) {
        return false;
    }
    if (location.startLine !== position.line) {
        return false;
    }
    if (location.startColumn !== undefined && location.startColumn !== position.character) {
        return false;
    }
    return true;
}

export interface ISimulationStatus {
    status: 'running' | 'paused' | 'finished';
    latestTime: TimePoint;
    nextSampleTime?: TimePoint;
}

export enum SimulationPauseReason {
    TimeReached,
    DiagnosticsReached,
}

export class Session {
    private connection: Connection;

    private secondaryLinks: ILink[] = [];
    private greetingPacketPromise: Promise<proto.ServerGreeting>;

    constructor(link: ILink) {
        this.connection = new Connection(link);
        this.greetingPacketPromise = new Promise((resolve, _reject) => {
            this.connection.onConnected = async (greetingPacket) => resolve(greetingPacket);
        });
        this.connection.onDisconnected = async () => {
            for (const secondaryLink of this.secondaryLinks) {
                secondaryLink.onDone();
            }
        };
        this.connection.onEvent = async (event) => {
            for (const secondaryLink of this.secondaryLinks) {
                secondaryLink.onRecv(event);
            }
            if (event.event === 'simulation_paused') {
                await this.handleSimulationPausedEvent(event.cause);
            } else if (event.event === 'simulation_finished') {
                await this.handleSimulationFinishedEvent();
            }
        };
        this.querySimulationStatus(); // populate nextSampleTime
    }

    dispose() {
        this.connection.dispose();
    }

    createSecondaryLink(): ILink {
        const link: ILink = {
            dispose: () => {
                this.secondaryLinks.splice(this.secondaryLinks.indexOf(link));
            },

            send: async (clientPacket) => {
                if (clientPacket.type === 'greeting') {
                    const serverGreetingPacket = await this.greetingPacketPromise;
                    if (clientPacket.version === serverGreetingPacket.version) {
                        await link.onRecv(serverGreetingPacket);
                    } else {
                        throw new Error(
                            `Secondary link requested greeting version ${clientPacket.version}, ` +
                            `but server greeting version is ${serverGreetingPacket.version}`
                        );
                    }
                } else {
                    const serverPacket = await this.connection.perform(clientPacket);
                    await link.onRecv(serverPacket);
                }
            },

            onRecv: async (serverPacket) => {},
            onDone: async () => {},
        };
        return link;
    }

    // ======================================== Inspecting the design

    private itemCache: Map<string, proto.ItemDescriptionMap> = new Map();
    private scopeCache: Map<string, proto.ScopeDescriptionMap> = new Map();
    private rootScopeDesc: proto.ScopeDescription | undefined;

    private async listItemsInScope(scopeIdentifier: string): Promise<proto.ItemDescriptionMap> {
        let itemDescriptionMap = this.itemCache.get(scopeIdentifier);
        if (itemDescriptionMap === undefined) {
            const response = await this.connection.listItems({
                type: 'command',
                command: 'list_items',
                scope: scopeIdentifier,
            });
            itemDescriptionMap = response.items;
            this.itemCache.set(scopeIdentifier, itemDescriptionMap);
        }
        return itemDescriptionMap;
    }

    private async listScopesInScope(scopeIdentifier: string): Promise<proto.ScopeDescriptionMap> {
        let scopeDescriptionMap = this.scopeCache.get(scopeIdentifier);
        if (scopeDescriptionMap === undefined) {
            const response = await this.connection.listScopes({
                type: 'command',
                command: 'list_scopes',
                scope: scopeIdentifier,
            });
            const filteredScopes = Object.keys(response.scopes).filter((scopeName) => {
                if (scopeIdentifier === '') {
                    return scopeName.length > 0 && scopeName.indexOf(' ') === -1;
                } else {
                    return (scopeName.startsWith(scopeIdentifier + ' ') &&
                        scopeName.indexOf(' ', scopeIdentifier.length + 1) === -1);
                }
            });
            scopeDescriptionMap = Object.fromEntries(filteredScopes.map((scopeName) =>
                [scopeName, response.scopes[scopeName]]));
            this.scopeCache.set(scopeIdentifier, scopeDescriptionMap);
        }
        return scopeDescriptionMap;
    }

    async getVariablesIn(scopeIdentifier: string): Promise<Variable[]> {
        const items = await this.listItemsInScope(scopeIdentifier);
        return Object.entries(items).map(([itemName, itemDesc]) =>
            Variable.fromCXXRTL(itemName, itemDesc));
    }

    async getScopesIn(scopeIdentifier: string): Promise<Scope[]> {
        const scopes = await this.listScopesInScope(scopeIdentifier);
        return Object.entries(scopes).map(([scopeName, scopeDesc]) =>
            Scope.fromCXXRTL(
                scopeName,
                scopeDesc,
                lazy(() => this.getScopesIn(scopeName)),
                lazy(() => this.getVariablesIn(scopeName)),
            ));
    }

    async getRootScope(): Promise<Scope> {
        const scopeName = '';
        if (this.rootScopeDesc === undefined) {
            const response = await this.connection.listScopes({
                type: 'command',
                command: 'list_scopes',
                scope: scopeName,
            });
            this.rootScopeDesc = response.scopes[scopeName];
            if (this.rootScopeDesc === undefined) {
                // This can happen if the root scope has never been defined anywhere, i.e. if it
                // is synthesized for the simulation, e.g. by passing `"top "` as the last argument
                // to the CXXRTL agent constructor.
                this.rootScopeDesc = {
                    type: 'module',
                    definition: {
                        src: null,
                        name: null,
                        attributes: {}
                    },
                    instantiation: {
                        src: null,
                        attributes: {}
                    },
                };
            }
        }
        return Scope.fromCXXRTL(
            scopeName,
            this.rootScopeDesc,
            lazy(() => this.getScopesIn(scopeName)),
            lazy(() => this.getVariablesIn(scopeName))
        );
    }

    async getVariable(variableIdentifier: string): Promise<Variable | null> {
        const identifierParts = variableIdentifier.split(' ');
        const scopeIdentifier = identifierParts.slice(0, identifierParts.length - 1).join(' ');
        const items = await this.listItemsInScope(scopeIdentifier);
        if (variableIdentifier in items) {
            return Variable.fromCXXRTL(variableIdentifier, items[variableIdentifier]);
        } else {
            return null;
        }
    }

    async getVariablesForLocation(filename: string, position: vscode.Position): Promise<Variable[]> {
        const variables: Variable[] = [];
        const extractVariablesForLocationFromScope = async (scope: string) => {
            const items = await this.listItemsInScope(scope);
            for (const [itemName, itemDesc] of Object.entries(items)) {
                const itemLocation = Location.fromCXXRTL(itemDesc.src);
                if (itemLocation !== null && matchLocation(itemLocation, filename, position)) {
                    variables.push(Variable.fromCXXRTL(itemName, itemDesc));
                }
            }
            const subScopes = await this.listScopesInScope(scope);
            for (const subScopeName of Object.keys(subScopes)) {
                await extractVariablesForLocationFromScope(subScopeName);
            }
            return null;
        };
        await extractVariablesForLocationFromScope('');
        return variables;
    }

    // ======================================== Querying the database

    private referenceEpochs: Map<string, number> = new Map();

    private advanceReferenceEpoch(name: string): number {
        const epoch = (this.referenceEpochs.get(name) || 0) + 1;
        this.referenceEpochs.set(name, epoch);
        return epoch;
    }

    private checkReferenceEpoch(name: string, requestedEpoch: number) {
        const currentEpoch = this.referenceEpochs.get(name);
        if (currentEpoch === undefined) {
            throw new ReferenceError(
                `Querying dangling reference ${name}#${requestedEpoch}`);
        } else if (currentEpoch !== requestedEpoch) {
            throw new ReferenceError(
                `Querying out-of-date reference ${name}#${requestedEpoch}; ` +
                `the current binding is ${name}#${currentEpoch}`);
        }
    }

    bindReference(name: string, reference: UnboundReference): Reference {
        const epoch = this.advanceReferenceEpoch(name);
        // Note that we do not wait for the command to complete. Although it is possible for
        // the command to fail, this would only happen if one of the designations is invalid,
        // which should never happen absent bugs. We still report the error in that case.
        this.connection.referenceItems({
            type: 'command',
            command: 'reference_items',
            reference: name,
            items: reference.cxxrtlItemDesignations()
        }).catch((error) => {
            console.error('[CXXRTL] Invalid designation while binding reference', `${name}#${epoch}`, error);
        });
        return new Reference(name, epoch, reference);
    }

    async queryInterval(
        interval: TimeInterval,
        options: {
            reference?: Reference,
            diagnostics?: boolean
            collapse?: boolean,
        } = {}
    ): Promise<Sample[]> {
        const reference = options.reference;
        if (reference !== undefined) {
            this.checkReferenceEpoch(reference.name, reference.epoch);
        }
        const response = await this.connection.queryInterval({
            type: 'command',
            command: 'query_interval',
            interval: interval.toCXXRTL(),
            items: reference?.name ?? null,
            item_values_encoding: reference ? 'base64(u32)' : null,
            diagnostics: options.diagnostics ?? false,
            collapse: options.collapse ?? true,
        });
        return response.samples.map((cxxrtlSample) => {
            let itemValuesArray = null;
            let diagnosticsArray = null;
            if (cxxrtlSample.item_values !== undefined) {
                const itemValuesBuffer = Buffer.from(cxxrtlSample.item_values, 'base64');
                itemValuesArray = new Uint32Array(
                    itemValuesBuffer.buffer,
                    itemValuesBuffer.byteOffset,
                    itemValuesBuffer.length / Uint32Array.BYTES_PER_ELEMENT
                );
            }
            if (cxxrtlSample.diagnostics !== undefined) {
                diagnosticsArray = Array.from(cxxrtlSample.diagnostics, Diagnostic.fromCXXRTL);
            }
            return new Sample(
                TimePoint.fromCXXRTL(cxxrtlSample.time),
                reference?.unbound ?? null,
                itemValuesArray,
                diagnosticsArray,
            );
        });
    }

    async queryAtCursor(options: {
        reference?: Reference,
        diagnostics?: boolean
    }): Promise<Sample> {
        const interval = new TimeInterval(this.timeCursor, this.timeCursor);
        const [sample] = await this.queryInterval(interval, options);
        return sample;
    }

    // ======================================== Manipulating the simulation

    private simulationStatusTimeout: NodeJS.Timeout | null = null;

    private _onDidChangeSimulationStatus: vscode.EventEmitter<ISimulationStatus> = new vscode.EventEmitter();
    readonly onDidChangeSimulationStatus: vscode.Event<ISimulationStatus> = this._onDidChangeSimulationStatus.event;

    private _onDidRunSimulation: vscode.EventEmitter<void> = new vscode.EventEmitter();
    readonly onDidRunSimulation: vscode.Event<void> = this._onDidRunSimulation.event;

    private _onDidPauseSimulation: vscode.EventEmitter<SimulationPauseReason> = new vscode.EventEmitter();
    readonly onDidPauseSimulation: vscode.Event<SimulationPauseReason> = this._onDidPauseSimulation.event;

    private _onDidFinishSimulation: vscode.EventEmitter<void> = new vscode.EventEmitter();
    readonly onDidFinishSimulation: vscode.Event<void> = this._onDidFinishSimulation.event;

    private _simulationStatus: ISimulationStatus = {
        status: 'paused',
        latestTime: TimePoint.ZERO,
    };

    get simulationStatus() {
        return this._simulationStatus;
    }

    private async querySimulationStatus(): Promise<void> {
        if (this.simulationStatusTimeout !== null) {
            clearTimeout(this.simulationStatusTimeout);
            this.simulationStatusTimeout = null;
        }
        const response = await this.connection.getSimulationStatus({
            type: 'command',
            command: 'get_simulation_status'
        });
        const currentSimulationStatus = {
            status: response.status,
            latestTime: TimePoint.fromCXXRTL(response.latest_time),
            nextSampleTime: (response.status === 'paused')
                ? TimePoint.fromCXXRTL(response.next_sample_time)
                : undefined,
        };
        if ((this._simulationStatus.status !== currentSimulationStatus.status) ||
                !this._simulationStatus.latestTime.equals(currentSimulationStatus.latestTime) ||
                // This part of the condition only fires once, when the initial status is updated.
                (this._simulationStatus.nextSampleTime === undefined &&
                    currentSimulationStatus.nextSampleTime !== undefined)) {
            this._simulationStatus = currentSimulationStatus;
            this._onDidChangeSimulationStatus.fire(this._simulationStatus);
        }
        if (currentSimulationStatus.status === 'running') {
            this.simulationStatusTimeout = setTimeout(() => this.querySimulationStatus(), 100);
        }
    }

    async runSimulation(options: {
        untilTime?: TimePoint,
        untilDiagnostics?: DiagnosticType[]
    } = {}): Promise<void> {
        await this.connection.runSimulation({
            type: 'command',
            command: 'run_simulation',
            until_time: options.untilTime?.toCXXRTL() ?? null,
            until_diagnostics: options.untilDiagnostics?.map((type) => <DiagnosticType>type) ?? [],
            sample_item_values: true
        });
        await this.querySimulationStatus();
        this._onDidRunSimulation.fire();
    }

    async pauseSimulation(): Promise<void> {
        await this.connection.pauseSimulation({
            type: 'command',
            command: 'pause_simulation'
        });
    }

    private async handleSimulationPausedEvent(cause: proto.PauseCause): Promise<void> {
        if (cause === 'until_time') {
            await this.querySimulationStatus();
            this._onDidPauseSimulation.fire(SimulationPauseReason.TimeReached);
        } else if (cause === 'until_diagnostics') {
            // The `until_diagnostics` cause is a little cursed. For `always @(posedge clk)`
            // assertions, the pause time will be two steps ahead, and for `always @(*)` ones,
            // it will usually be one step ahead. This is because of several fencepost issues with
            // both the storage and the retrieval of diagnostics, which are baked into the CXXRTL
            // execution and replay model. (Diagnostics recorded from C++ are fine.)
            //
            // To handle this, rather than relying on the event time, we scan the database for any
            // diagnostics since the last time the simulation state was updated. (A diagnostic that
            // caused the simulation to be paused must be somewhere between that and the latest
            // sample in the database at the time of pausing.) This avoids the need to simulate
            // the entire interval twice, as would happen if querying the interval between the "Run
            // Simulation Until Diagnostics" command and the time of pausing.
            const latestTimeBeforePause = this.simulationStatus.latestTime;
            await this.querySimulationStatus();
            const latestTimeAfterPause = this.simulationStatus.latestTime;
            const diagnosticAt = await this.searchIntervalForDiagnostics(
                new TimeInterval(latestTimeBeforePause, latestTimeAfterPause));
            if (diagnosticAt === null) {
                console.error('[CXXRTL] Paused on diagnostic but no such diagnostics found');
                return;
            }
            this.timeCursor = diagnosticAt;
            this._onDidPauseSimulation.fire(SimulationPauseReason.DiagnosticsReached);
        }
    }

    private async handleSimulationFinishedEvent(): Promise<void> {
        await this.querySimulationStatus();
        this._onDidFinishSimulation.fire();
    }

    get isSimulationRunning(): boolean {
        return this._simulationStatus.status === 'running';
    }

    // ======================================== Manipulating the time cursor

    private _onDidChangeTimeCursor: vscode.EventEmitter<TimePoint> = new vscode.EventEmitter<TimePoint>();
    readonly onDidChangeTimeCursor: vscode.Event<TimePoint> = this._onDidChangeTimeCursor.event;

    private _timeCursor: TimePoint = TimePoint.ZERO;

    // We don't know how far forward the next time step will be; the server doesn't provide this
    // information. A typical simulation has a consistent time step, or at least a time step of
    // a consistent order of magnitude; we guess this time step using binary search and then look
    // ahead to find out the actual next cursor position. The advantage of this approach is that
    // the simulation can advance its timeline however it wants.
    private _forwardTimeStep: bigint = 1n; // in femtos

    get timeCursor() {
        return this._timeCursor;
    }

    set timeCursor(newTimeCursor: TimePoint) {
        if (newTimeCursor.lessThan(TimePoint.ZERO) ||
                newTimeCursor.greaterThan(this.simulationStatus.latestTime)) {
            throw new RangeError('Time cursor out of range');
        }
        this._timeCursor = newTimeCursor;
        this._onDidChangeTimeCursor.fire(this._timeCursor);
    }

    async stepForward(): Promise<TimePoint> {
        if (this.timeCursor.equals(this.simulationStatus.latestTime)) {
            if (this.simulationStatus.status === 'paused') {
                const nextSampleTime = this.simulationStatus.nextSampleTime!;
                await this.runSimulation({ untilTime: nextSampleTime });
                if (!nextSampleTime.greaterThan(this.simulationStatus.latestTime)) {
                    this.timeCursor = nextSampleTime;
                }
            }
        } else {
            let ordersOfMagnitude = 0;
            while (true) {
                const followingTimePoint = this.timeCursor.offsetByFemtos(this._forwardTimeStep);
                const response = await this.connection.queryInterval({
                    type: 'command',
                    command: 'query_interval',
                    interval: new TimeInterval(this._timeCursor, followingTimePoint).toCXXRTL(),
                    collapse: true,
                    items: null,
                    item_values_encoding: null,
                    diagnostics: false
                });
                if (response.samples.length > 1) {
                    this.timeCursor = TimePoint.fromCXXRTL(response.samples.at(1)!.time);
                    break;
                } else if (ordersOfMagnitude < 30 /* femto -> peta */) {
                    ordersOfMagnitude += 1;
                    this._forwardTimeStep = this._forwardTimeStep * 10n;
                } else {
                    throw new RangeError('Could not find a sample to step forward to');
                }
            }
        }
        return this.timeCursor;
    }

    async stepBackward(): Promise<TimePoint> {
        if (!this.timeCursor.equals(TimePoint.ZERO)) {
            const precedingTimePoint = this.timeCursor.offsetByFemtos(-1n);
            const response = await this.connection.queryInterval({
                type: 'command',
                command: 'query_interval',
                interval: new TimeInterval(precedingTimePoint, precedingTimePoint).toCXXRTL(),
                collapse: true,
                items: null,
                item_values_encoding: null,
                diagnostics: false
            });
            this.timeCursor = TimePoint.fromCXXRTL(response.samples.at(0)!.time);
        }
        return this.timeCursor;
    }

    async continueForward(): Promise<void> {
        if (this.timeCursor.lessThan(this.simulationStatus.latestTime)) {
            const diagnosticAt = await this.searchIntervalForDiagnostics(
                new TimeInterval(this.timeCursor, this.simulationStatus.latestTime));
            if (diagnosticAt !== null) {
                this.timeCursor = diagnosticAt;
                return;
            }
        }
        // No diagnostics between time cursor and end of database; run the simulation.
        if (this.simulationStatus.status === 'paused') {
            // The pause handler will run `searchIntervalForDiagnostics`.
            await this.runSimulation({
                untilDiagnostics: [
                    DiagnosticType.Assert,
                    DiagnosticType.Assume,
                    DiagnosticType.Break
                ]
            });
        } else if (this.simulationStatus.status === 'finished') {
            this.timeCursor = this.simulationStatus.latestTime;
        }
    }

    private async searchIntervalForDiagnostics(interval: TimeInterval): Promise<TimePoint | null> {
        const response = await this.connection.queryInterval({
            type: 'command',
            command: 'query_interval',
            interval: interval.toCXXRTL(),
            collapse: true,
            items: null,
            item_values_encoding: null,
            diagnostics: true
        });
        for (const sample of response.samples) {
            const sampleTime = TimePoint.fromCXXRTL(sample.time);
            if (!sampleTime.greaterThan(interval.begin)) {
                continue;
            }
            for (const diagnostic of sample.diagnostics!) {
                if (['break', 'assert', 'assume'].includes(diagnostic.type)) {
                    return sampleTime;
                }
            }
        }
        return null;
    }
}
