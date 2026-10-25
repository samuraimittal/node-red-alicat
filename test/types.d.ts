// Type shims for dev dependencies that ship no type definitions. Tests only.

declare module 'node-red-node-test-helper' {
    import type { SinonSpy } from 'sinon';
    import type { EventEmitter } from 'events';

    namespace helper {
        /** A deployed node as the helper returns it: every method of Node-RED's node API is wrapped in a sinon spy. */
        interface TestNode extends EventEmitter {
            id: string;
            type: string;
            name?: string;
            z?: string;
            receive(msg?: object): void;
            send: SinonSpy;
            status: SinonSpy<[{ fill?: string; shape?: string; text?: string }], void>;
            log: SinonSpy;
            warn: SinonSpy;
            error: SinonSpy;
            debug: SinonSpy;
            trace: SinonSpy;
            context(): {
                get(key: string, store?: string): unknown;
                set(key: string, value: unknown, store?: string): void;
                flow: { get(key: string, store?: string): unknown };
                global: { get(key: string, store?: string): unknown };
            };
            /** Node-specific state (a config node's lease, a read node's subscription, ...). */
            [key: string]: unknown;
        }

        /** A node module's export; the helper calls it with its own runtime object. */
        type NodeModule = (RED: never) => void;
        type FlowNode = { id: string; type: string; [key: string]: unknown };

        interface SuperTestRequest extends PromiseLike<{ status: number; body: any }> {
            send(body: object): SuperTestRequest;
            set(header: string, value: string): SuperTestRequest;
            expect(status: number): SuperTestRequest;
        }

        interface Helper {
            init(nodeRedRuntime: string, userSettings?: object): void;
            settings(userSettings: object): void;
            load(nodes: NodeModule | NodeModule[], flow: FlowNode[], credentials?: object): Promise<void>;
            unload(): Promise<void>;
            getNode(id: string): TestNode;
            setFlows(flow: FlowNode[], type?: string): Promise<void>;
            startServer(done: () => void): void;
            stopServer(done: () => void): void;
            /** supertest agent for the admin HTTP API. */
            request(): { get(path: string): SuperTestRequest; post(path: string): SuperTestRequest };
        }
    }

    const helper: helper.Helper;
    export = helper;
}

declare module 'node-red' {
    /** The embedded runtime, as the compatibility and soak harnesses use it. */
    const RED: {
        version(): string;
        init(settings: object): void;
        init(server: object | null, settings: object): void;
        start(): Promise<void>;
        stop(): Promise<void>;
        hooks: { add(hook: string, fn: (event: { msg: object; destination: { id: string } }) => void): void };
        runtime: {
            flows: {
                setFlows(opts: { flows: { flows: object[] }; deploymentType?: string; user?: object }): Promise<string>;
                setState(opts: { state: 'start' | 'stop'; user?: object }): Promise<unknown>;
            };
        };
    };
    export = RED;
}

/** Node-RED's core nodes, loaded by path in the node tests. */
declare module '@node-red/nodes/*' {
    const node: (RED: never) => void;
    export = node;
}
