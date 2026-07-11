"use strict";

const net = require("node:net");
const { spawn } = require("node:child_process");
const utils = require("@iobroker/adapter-core");

const SERVICE = {
    MMS: "mms",
    REPORTS: "reports",
    GOOSE: "goose",
    SAMPLED_VALUES: "sampled-values",
};

const RAW_SERVICE = {
    goose: {
        label: "GOOSE",
        stateRoot: "goose",
        etherType: 0x88b8,
        interfaceKey: "gooseInterface",
        appIdKey: "gooseAppId",
        captureKey: "gooseCaptureEnabled",
        publishKey: "goosePublishEnabled",
    },
    sampledValues: {
        label: "Sampled Values",
        stateRoot: "sampledValues",
        etherType: 0x88ba,
        interfaceKey: "sampledValuesInterface",
        appIdKey: "sampledValuesAppId",
        captureKey: "sampledValuesCaptureEnabled",
        publishKey: "sampledValuesPublishEnabled",
    },
};

function asArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return value
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }
    }
    return [];
}

function stateIdPart(value, fallback) {
    const raw = String(value || fallback || "item").trim();
    return raw.replace(/[.\s]+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 80) || "item";
}

function valueType(type) {
    if (type === "boolean" || type === "number" || type === "string") {
        return type;
    }
    return "mixed";
}

function cleanHex(value) {
    return String(value || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

function formatMac(buffer, offset) {
    return [...buffer.subarray(offset, offset + 6)].map(byte => byte.toString(16).padStart(2, "0")).join(":");
}

function parseIec61850RawFrame(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 22) {
        return null;
    }

    let etherTypeOffset = 12;
    let etherType = frame.readUInt16BE(etherTypeOffset);
    let vlan = null;
    if (etherType === 0x8100 && frame.length >= 26) {
        const tci = frame.readUInt16BE(14);
        vlan = {
            priority: (tci >> 13) & 0x07,
            id: tci & 0x0fff,
        };
        etherTypeOffset = 16;
        etherType = frame.readUInt16BE(etherTypeOffset);
    }

    if (etherType !== 0x88b8 && etherType !== 0x88ba) {
        return null;
    }

    const headerOffset = etherTypeOffset + 2;
    if (frame.length < headerOffset + 8) {
        return null;
    }

    const appId = frame.readUInt16BE(headerOffset);
    const declaredLength = frame.readUInt16BE(headerOffset + 2);
    const reserved1 = frame.readUInt16BE(headerOffset + 4);
    const reserved2 = frame.readUInt16BE(headerOffset + 6);
    const payload = frame.subarray(headerOffset + 8);

    return {
        protocol: etherType === 0x88b8 ? "GOOSE" : "Sampled Values",
        etherType,
        destinationMac: formatMac(frame, 0),
        sourceMac: formatMac(frame, 6),
        vlan,
        appId,
        declaredLength,
        reserved1,
        reserved2,
        payload,
    };
}

class Iec61850Adapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "iec61850",
        });

        this.client = null;
        this.server = null;
        this.reconnectTimer = null;
        this.statusTimer = null;
        this.bytesRx = 0;
        this.bytesTx = 0;
        this.clientConnected = false;
        this.serverConnections = new Set();
        this.rawCaptures = new Map();

        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", callback => this.onUnload(callback));
    }

    get services() {
        const services = new Set(asArray(this.config.services));
        if (this.config.serviceMms !== false) {
            services.add(SERVICE.MMS);
        }
        if (this.config.serviceReports !== false) {
            services.add(SERVICE.REPORTS);
        }
        if (this.config.serviceGoose === true) {
            services.add(SERVICE.GOOSE);
        }
        if (this.config.serviceSampledValues === true) {
            services.add(SERVICE.SAMPLED_VALUES);
        }
        return services;
    }

    get role() {
        return ["client", "server", "both"].includes(this.config.role) ? this.config.role : "client";
    }

    async onReady() {
        await this.createConfiguredObjects();
        await this.setState("info.connection", false, true);
        await this.setState("info.mode", this.role, true);
        await this.setState("info.services", [...this.services].join(","), true);
        await this.setState("diagnostics.status", "starting", true);
        await this.setState("diagnostics.lastError", "", true);
        await this.setState("diagnostics.bytesRx", 0, true);
        await this.setState("diagnostics.bytesTx", 0, true);
        await this.initializeRawStates("goose");
        await this.initializeRawStates("sampledValues");

        this.subscribeStates("points.*.set");
        this.subscribeStates("goose.publishFrameHex");
        this.subscribeStates("sampledValues.publishFrameHex");

        if (!this.config.enabled) {
            await this.setState("diagnostics.status", "disabled", true);
            this.log.info("IEC 61850 adapter is disabled in the instance configuration.");
            return;
        }

        this.startStatusTimer();

        if (this.services.has(SERVICE.MMS)) {
            if (this.role === "client" || this.role === "both") {
                this.startMmsClient();
            }
            if (this.role === "server" || this.role === "both") {
                this.startMmsServer();
            }
        }

        if (this.services.has(SERVICE.REPORTS)) {
            await this.setState("reports.status", "configured", true);
        }

        if (this.services.has(SERVICE.GOOSE)) {
            await this.startRawEthernetService("goose");
        }

        if (this.services.has(SERVICE.SAMPLED_VALUES)) {
            await this.startRawEthernetService("sampledValues");
        }

        await this.updateConnectionState();
    }

    async createConfiguredObjects() {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectNotExistsAsync("diagnostics", {
            type: "channel",
            common: { name: "Diagnostics" },
            native: {},
        });
        await this.setObjectNotExistsAsync("reports", {
            type: "channel",
            common: { name: "Reports" },
            native: {},
        });
        await this.setObjectNotExistsAsync("points", {
            type: "channel",
            common: { name: "Data points" },
            native: {},
        });
        await this.setObjectNotExistsAsync("goose", {
            type: "channel",
            common: { name: "GOOSE" },
            native: {},
        });
        await this.setObjectNotExistsAsync("sampledValues", {
            type: "channel",
            common: { name: "Sampled Values" },
            native: {},
        });
        await this.setObjectNotExistsAsync("mms", {
            type: "channel",
            common: { name: "MMS" },
            native: {},
        });

        await this.ensureState("info.connection", "Connected", "boolean", "indicator.connected");
        await this.ensureState("info.mode", "Mode", "string", "state");
        await this.ensureState("info.services", "Services", "string", "state");
        await this.ensureState("diagnostics.status", "Status", "string", "state");
        await this.ensureState("diagnostics.lastError", "Last error", "string", "state");
        await this.ensureState("diagnostics.bytesRx", "Bytes received", "number", "state", "byte");
        await this.ensureState("diagnostics.bytesTx", "Bytes transmitted", "number", "state", "byte");
        await this.ensureState("diagnostics.lastFrameHex", "Last frame hex", "string", "state");
        await this.ensureState("mms.clientConnected", "MMS client connected", "boolean", "indicator.connected");
        await this.ensureState("mms.serverConnections", "MMS server connections", "number", "value");
        await this.ensureState("reports.status", "Report status", "string", "state");
        await this.ensureState("goose.status", "GOOSE status", "string", "state");
        await this.ensureState("goose.captureActive", "GOOSE capture active", "boolean", "indicator");
        await this.ensureState("goose.frameCount", "GOOSE frame count", "number", "value");
        await this.ensureState("goose.lastAppId", "GOOSE last AppID", "number", "value");
        await this.ensureState("goose.lastSourceMac", "GOOSE last source MAC", "string", "state");
        await this.ensureState("goose.lastDestinationMac", "GOOSE last destination MAC", "string", "state");
        await this.ensureState("goose.lastPayloadHex", "GOOSE last payload hex", "string", "state");
        await this.ensureState("goose.lastFrameHex", "GOOSE last frame hex", "string", "state");
        await this.ensureState("goose.lastTimestamp", "GOOSE last timestamp", "string", "state");
        await this.ensureState("goose.publishFrameHex", "GOOSE publish raw Ethernet frame hex", "string", "state");
        await this.ensureState("sampledValues.status", "Sampled Values status", "string", "state");
        await this.ensureState("sampledValues.captureActive", "Sampled Values capture active", "boolean", "indicator");
        await this.ensureState("sampledValues.frameCount", "Sampled Values frame count", "number", "value");
        await this.ensureState("sampledValues.lastAppId", "Sampled Values last AppID", "number", "value");
        await this.ensureState("sampledValues.lastSourceMac", "Sampled Values last source MAC", "string", "state");
        await this.ensureState("sampledValues.lastDestinationMac", "Sampled Values last destination MAC", "string", "state");
        await this.ensureState("sampledValues.lastPayloadHex", "Sampled Values last payload hex", "string", "state");
        await this.ensureState("sampledValues.lastFrameHex", "Sampled Values last frame hex", "string", "state");
        await this.ensureState("sampledValues.lastTimestamp", "Sampled Values last timestamp", "string", "state");
        await this.ensureState("sampledValues.publishFrameHex", "Sampled Values publish raw Ethernet frame hex", "string", "state");

        const reports = asArray(this.config.reports);
        for (const [index, report] of reports.entries()) {
            const id = stateIdPart(report.id || report.reference || report.name, `report_${index + 1}`);
            await this.setObjectNotExistsAsync(`reports.${id}`, {
                type: "channel",
                common: { name: report.name || report.reference || id },
                native: { reference: report.reference || "", enabled: report.enabled !== false },
            });
            await this.ensureState(`reports.${id}.enabled`, "Enabled", "boolean", "switch");
            await this.ensureState(`reports.${id}.reference`, "Object reference", "string", "state");
            await this.ensureState(`reports.${id}.lastUpdate`, "Last update", "string", "state");
            await this.ensureState(`reports.${id}.value`, "Last value", "mixed", "state");
            await this.setState(`reports.${id}.enabled`, report.enabled !== false, true);
            await this.setState(`reports.${id}.reference`, report.reference || "", true);
        }

        const points = asArray(this.config.points);
        for (const [index, point] of points.entries()) {
            const id = stateIdPart(point.id || point.reference || point.name, `point_${index + 1}`);
            await this.setObjectNotExistsAsync(`points.${id}`, {
                type: "channel",
                common: { name: point.name || point.reference || id },
                native: { reference: point.reference || "", write: !!point.write },
            });
            await this.ensureState(`points.${id}.value`, point.name || id, valueType(point.type), "state");
            await this.ensureState(`points.${id}.reference`, "IEC 61850 reference", "string", "state");
            await this.ensureState(`points.${id}.quality`, "Quality", "string", "state");
            await this.ensureState(`points.${id}.timestamp`, "Timestamp", "string", "state");
            await this.setState(`points.${id}.reference`, point.reference || "", true);
            await this.setState(`points.${id}.quality`, "not-connected", true);
            if (point.write) {
                await this.ensureState(`points.${id}.set`, `${point.name || id} set value`, valueType(point.type), "state");
            }
        }
    }

    async ensureState(id, name, type, role, unit) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: {
                name,
                type,
                role,
                read: true,
                write: role === "switch" || id.endsWith(".set") || id.endsWith(".publishFrameHex"),
                unit,
            },
            native: {},
        });
    }

    async initializeRawStates(service) {
        const root = RAW_SERVICE[service].stateRoot;
        await this.setState(`${root}.status`, "idle", true);
        await this.setState(`${root}.captureActive`, false, true);
        await this.setState(`${root}.frameCount`, 0, true);
        await this.setState(`${root}.lastAppId`, 0, true);
        await this.setState(`${root}.lastSourceMac`, "", true);
        await this.setState(`${root}.lastDestinationMac`, "", true);
        await this.setState(`${root}.lastPayloadHex`, "", true);
        await this.setState(`${root}.lastFrameHex`, "", true);
        await this.setState(`${root}.lastTimestamp`, "", true);
        await this.setState(`${root}.publishFrameHex`, "", true);
    }

    startMmsClient() {
        this.clearReconnectTimer();
        const host = String(this.config.mmsHost || "").trim();
        const port = Number(this.config.mmsPort) || 102;

        if (!host) {
            this.setError("MMS client host is empty.");
            return;
        }

        this.log.info(`Connecting IEC 61850 MMS TCP client to ${host}:${port}`);
        const socket = net.createConnection({ host, port });
        this.client = socket;
        socket.setTimeout(Number(this.config.connectTimeoutMs) || 10000);

        socket.on("connect", async () => {
            this.clientConnected = true;
            socket.setTimeout(0);
            this.log.info(`IEC 61850 MMS TCP client connected to ${host}:${port}`);
            await this.setState("mms.clientConnected", true, true);
            await this.setState("diagnostics.status", "mms-client-connected", true);
            await this.updateConnectionState();
        });

        socket.on("data", data => this.handleMmsData(data, "client"));
        socket.on("timeout", () => socket.destroy(new Error("MMS client connection timeout")));
        socket.on("error", error => this.setError(`MMS client error: ${error.message}`));
        socket.on("close", async () => {
            if (this.client === socket) {
                this.client = null;
            }
            this.clientConnected = false;
            await this.setState("mms.clientConnected", false, true);
            await this.updateConnectionState();
            this.scheduleReconnect();
        });
    }

    startMmsServer() {
        const bind = String(this.config.mmsBind || "0.0.0.0").trim();
        const port = Number(this.config.mmsServerPort) || 8102;
        this.server = net.createServer(socket => this.handleServerConnection(socket));
        this.server.on("error", error => this.setError(`MMS server error: ${error.message}`));
        this.server.listen(port, bind, async () => {
            this.log.info(`IEC 61850 MMS TCP server listening on ${bind}:${port}`);
            await this.setState("diagnostics.status", "mms-server-listening", true);
            await this.updateConnectionState();
        });
    }

    handleServerConnection(socket) {
        const label = `${socket.remoteAddress || "unknown"}:${socket.remotePort || 0}`;
        this.serverConnections.add(socket);
        this.log.info(`IEC 61850 MMS TCP server connection from ${label}`);
        this.setState("mms.serverConnections", this.serverConnections.size, true).catch(error =>
            this.log.warn(`Could not update server connection count: ${error.message}`),
        );
        this.updateConnectionState().catch(error => this.log.warn(`Could not update connection state: ${error.message}`));

        socket.on("data", data => this.handleMmsData(data, "server"));
        socket.on("error", error => this.log.warn(`MMS server socket error from ${label}: ${error.message}`));
        socket.on("close", () => {
            this.serverConnections.delete(socket);
            this.setState("mms.serverConnections", this.serverConnections.size, true).catch(error =>
                this.log.warn(`Could not update server connection count: ${error.message}`),
            );
            this.updateConnectionState().catch(error =>
                this.log.warn(`Could not update connection state: ${error.message}`),
            );
        });
    }

    async handleMmsData(data, source) {
        this.bytesRx += data.length;
        await this.setState("diagnostics.bytesRx", this.bytesRx, true);
        await this.setState("diagnostics.lastFrameHex", data.toString("hex").slice(0, 512), true);
        await this.setState("diagnostics.status", `mms-${source}-frame-received`, true);
        this.log.debug(`IEC 61850 MMS ${source} frame: ${data.toString("hex")}`);
    }

    async startRawEthernetService(service) {
        const definition = RAW_SERVICE[service];
        const iface = String(this.config[definition.interfaceKey] || "").trim();
        const appId = String(this.config[definition.appIdKey] || "").trim();

        if (!iface) {
            const message = `${definition.label} interface is not configured.`;
            this.log.warn(message);
            await this.setState(`${definition.stateRoot}.status`, message, true);
            await this.setState(`${definition.stateRoot}.captureActive`, false, true);
            return;
        }

        await this.setState(
            `${definition.stateRoot}.status`,
            `${definition.label} configured on ${iface}, appId=${appId || "any"}`,
            true,
        );

        if (this.config[definition.captureKey] !== false) {
            this.startRawCapture(service, definition, iface, appId);
        }
    }

    startRawCapture(service, definition, iface, appId) {
        if (this.rawCaptures.has(service)) {
            return;
        }

        const filter = `ether proto 0x${definition.etherType.toString(16)}`;
        const args = ["-n", "-l", "-e", "-xx", "-s", "0", "-i", iface, filter];
        const proc = spawn("tcpdump", args, { stdio: ["ignore", "pipe", "pipe"] });
        const capture = {
            proc,
            frameCount: 0,
            lineBuffer: "",
            hexWords: [],
            packetActive: false,
            service,
            definition,
            appId,
        };
        this.rawCaptures.set(service, capture);

        proc.stdout.on("data", chunk => this.handleTcpdumpOutput(capture, chunk.toString("utf8")));
        proc.stderr.on("data", chunk => {
            const text = chunk.toString("utf8").trim();
            if (text) {
                this.log.warn(`${definition.label} capture: ${text}`);
            }
        });
        proc.on("error", error => {
            this.setRawCaptureStatus(capture, `capture error: ${error.message}`, false).catch(err =>
                this.log.warn(`Could not update ${definition.label} status: ${err.message}`),
            );
        });
        proc.on("exit", (code, signal) => {
            this.rawCaptures.delete(service);
            this.setRawCaptureStatus(capture, `capture stopped code=${code} signal=${signal || ""}`.trim(), false).catch(
                error => this.log.warn(`Could not update ${definition.label} status: ${error.message}`),
            );
        });

        this.setRawCaptureStatus(capture, `capture running on ${iface}`, true).catch(error =>
            this.log.warn(`Could not update ${definition.label} status: ${error.message}`),
        );
    }

    handleTcpdumpOutput(capture, text) {
        capture.lineBuffer += text;
        const lines = capture.lineBuffer.split(/\r?\n/);
        capture.lineBuffer = lines.pop() || "";

        for (const line of lines) {
            const hexLine = line.match(/^\s*0x[0-9a-fA-F]+:\s+(.+)$/);
            if (hexLine) {
                capture.packetActive = true;
                const words = hexLine[1].match(/\b(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{2})\b/g) || [];
                capture.hexWords.push(...words);
                continue;
            }

            if (capture.packetActive && capture.hexWords.length) {
                this.finishRawPacket(capture).catch(error =>
                    this.log.warn(`Could not process ${capture.definition.label} frame: ${error.message}`),
                );
            }
            capture.packetActive = false;
            capture.hexWords = [];
        }
    }

    async finishRawPacket(capture) {
        const hex = cleanHex(capture.hexWords.join(""));
        capture.hexWords = [];
        capture.packetActive = false;
        if (!hex || hex.length < 44) {
            return;
        }

        const frame = Buffer.from(hex, "hex");
        const parsed = parseIec61850RawFrame(frame);
        if (!parsed || parsed.etherType !== capture.definition.etherType) {
            return;
        }

        if (capture.appId) {
            const expected = Number.parseInt(cleanHex(capture.appId), 16);
            if (Number.isFinite(expected) && parsed.appId !== expected) {
                return;
            }
        }

        capture.frameCount += 1;
        this.bytesRx += frame.length;
        const root = capture.definition.stateRoot;
        await this.setState(`${root}.frameCount`, capture.frameCount, true);
        await this.setState(`${root}.lastAppId`, parsed.appId, true);
        await this.setState(`${root}.lastSourceMac`, parsed.sourceMac, true);
        await this.setState(`${root}.lastDestinationMac`, parsed.destinationMac, true);
        await this.setState(`${root}.lastPayloadHex`, parsed.payload.toString("hex"), true);
        await this.setState(`${root}.lastFrameHex`, frame.toString("hex"), true);
        await this.setState(`${root}.lastTimestamp`, new Date().toISOString(), true);
        await this.setState("diagnostics.bytesRx", this.bytesRx, true);
        await this.setState("diagnostics.lastFrameHex", frame.toString("hex").slice(0, 512), true);
        await this.setState("diagnostics.status", `${root}-frame-received`, true);
    }

    async setRawCaptureStatus(capture, status, active) {
        await this.setState(`${capture.definition.stateRoot}.status`, status, true);
        await this.setState(`${capture.definition.stateRoot}.captureActive`, active, true);
        await this.updateConnectionState();
    }

    async publishRawFrame(service, frameHex) {
        const definition = RAW_SERVICE[service];
        const iface = String(this.config[definition.interfaceKey] || "").trim();
        const hex = cleanHex(frameHex);
        if (!this.config[definition.publishKey]) {
            throw new Error(`${definition.label} publishing is disabled in the adapter configuration.`);
        }
        if (!iface) {
            throw new Error(`${definition.label} interface is not configured.`);
        }
        if (hex.length < 44 || hex.length % 2 !== 0) {
            throw new Error(`${definition.label} frame hex is invalid or too short.`);
        }
        const parsed = parseIec61850RawFrame(Buffer.from(hex, "hex"));
        if (!parsed || parsed.etherType !== definition.etherType) {
            throw new Error(`${definition.label} frame does not contain EtherType 0x${definition.etherType.toString(16)}.`);
        }

        await this.sendRawFrame(iface, hex);
        this.bytesTx += hex.length / 2;
        await this.setState("diagnostics.bytesTx", this.bytesTx, true);
        await this.setState(`${definition.stateRoot}.status`, `published raw frame on ${iface}`, true);
    }

    sendRawFrame(iface, hex) {
        return new Promise((resolve, reject) => {
            const script = [
                "import socket,sys",
                "iface=sys.argv[1]",
                "data=bytes.fromhex(sys.argv[2])",
                "s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW)",
                "s.bind((iface,0))",
                "s.send(data)",
                "s.close()",
            ].join("; ");
            const proc = spawn("python3", ["-c", script, iface, hex], { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            proc.stderr.on("data", chunk => {
                stderr += chunk.toString("utf8");
            });
            proc.on("error", reject);
            proc.on("exit", code => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(stderr.trim() || `python3 raw socket sender exited with code ${code}`));
                }
            });
        });
    }

    scheduleReconnect() {
        if (!this.config.enabled || !this.services.has(SERVICE.MMS) || !(this.role === "client" || this.role === "both")) {
            return;
        }
        this.clearReconnectTimer();
        const delay = Number(this.config.reconnectDelayMs) || 10000;
        this.reconnectTimer = setTimeout(() => this.startMmsClient(), delay);
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    startStatusTimer() {
        const interval = Math.max(1000, Number(this.config.pollIntervalMs) || 30000);
        this.statusTimer = setInterval(() => {
            this.updateConnectionState().catch(error => this.log.warn(`Could not update status: ${error.message}`));
        }, interval);
    }

    async updateConnectionState() {
        const connected =
            this.clientConnected ||
            this.serverConnections.size > 0 ||
            (!!this.server && (this.role === "server" || this.role === "both")) ||
            this.rawCaptures.size > 0;
        await this.setState("info.connection", connected, true);
        await this.setState("mms.clientConnected", this.clientConnected, true);
        await this.setState("mms.serverConnections", this.serverConnections.size, true);
    }

    async setError(message) {
        this.log.warn(message);
        await this.setState("diagnostics.lastError", message, true);
        await this.setState("diagnostics.status", "error", true);
        await this.updateConnectionState();
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        if (id.endsWith(".publishFrameHex")) {
            const localId = id.replace(`${this.namespace}.`, "");
            const service = localId.startsWith("goose.") ? "goose" : "sampledValues";
            try {
                await this.publishRawFrame(service, state.val);
                await this.setState(localId, state.val, true);
            } catch (error) {
                await this.setError(error.message);
            }
            return;
        }
        if (!id.endsWith(".set")) {
            return;
        }
        const localId = id.replace(`${this.namespace}.`, "");
        const valueId = localId.replace(/\.set$/, ".value");
        await this.setState(valueId, state.val, true);
        await this.setState(localId, state.val, true);
        await this.setState(valueId.replace(/\.value$/, ".timestamp"), new Date().toISOString(), true);
        await this.setState(valueId.replace(/\.value$/, ".quality"), "local-write-buffered", true);
        this.log.info(`Buffered IEC 61850 write for ${valueId}: ${state.val}`);
    }

    onUnload(callback) {
        try {
            this.clearReconnectTimer();
            if (this.statusTimer) {
                clearInterval(this.statusTimer);
                this.statusTimer = null;
            }
            if (this.client) {
                this.client.destroy();
                this.client = null;
            }
            for (const socket of this.serverConnections) {
                socket.destroy();
            }
            this.serverConnections.clear();
            for (const capture of this.rawCaptures.values()) {
                capture.proc.kill("SIGTERM");
            }
            this.rawCaptures.clear();
            if (this.server) {
                this.server.close();
                this.server = null;
            }
            callback();
        } catch (error) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Iec61850Adapter(options);
} else {
    new Iec61850Adapter();
}
