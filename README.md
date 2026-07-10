# ioBroker IEC 61850

ioBroker adapter foundation for IEC 61850 communication with selectable client/server mode, MMS TCP diagnostics, report data points and guarded GOOSE/Sampled Values configuration.

German documentation is available here: [README.de.md](README.de.md).

## Current scope

This first test version is built to install cleanly in ioBroker and provide a structured IEC 61850 adapter base. It contains:

- Client, server or combined role selection.
- MMS TCP client connection to an IEC 61850 device, normally TCP port `102`.
- MMS TCP server listener for lab tests, default port `8102`.
- Report Control Block configuration and ioBroker report states.
- Manual IEC 61850 data point mapping.
- GOOSE and Sampled Values configuration with clear diagnostics.

Full IEC 61850 MMS object browsing, ASN.1 MMS service decoding, GOOSE publishing/subscribing and Sampled Values decoding require a native IEC 61850 backend such as libIEC61850 or an equivalent system component. This adapter version prepares the ioBroker side and exposes safe diagnostics until that backend is added.

## Requirements

- ioBroker with js-controller 6 or newer.
- Node.js 22 or newer.
- For MMS client mode: TCP access to the IED or gateway.
- For real MMS server mode on TCP `102`: permission to bind privileged ports, or use a test port such as `8102`.
- For GOOSE and Sampled Values: Linux raw Ethernet access, correct network interface and later a native IEC 61850 backend.

## Configuration

### General

Set `Enable adapter` only after the target settings are correct. Select:

- `Client`: connect to an IEC 61850 MMS server.
- `Server`: listen locally for MMS TCP clients.
- `Client + Server`: do both at the same time.

Select services:

- `MMS`: TCP-based Manufacturing Message Specification transport.
- `Reports`: Report Control Block state model.
- `GOOSE`: raw Ethernet event messages.
- `Sampled Values`: raw Ethernet sampled measurement streams.

### MMS

For client mode:

- `MMS server host`: IP address or DNS name of the IED.
- `MMS server port`: normally `102`.
- `Connect timeout ms`: connection timeout.
- `Reconnect delay ms`: delay before reconnect.

For server mode:

- `Server bind address`: local bind IP, usually `0.0.0.0`.
- `Local server port`: `8102` for tests or `102` for real MMS if the host permits it.

### Reports

Each report entry creates states below:

```text
iec61850.0.reports.<id>.enabled
iec61850.0.reports.<id>.reference
iec61850.0.reports.<id>.lastUpdate
iec61850.0.reports.<id>.value
```

Example report reference:

```text
IED1LD0/LLN0.RP.Events
```

### Data points

Manual data points create states below:

```text
iec61850.0.points.<id>.value
iec61850.0.points.<id>.reference
iec61850.0.points.<id>.quality
iec61850.0.points.<id>.timestamp
```

Writable points also get:

```text
iec61850.0.points.<id>.set
```

Writes are buffered into the ioBroker value state in this first version. A later MMS backend can use the same state to send real IEC 61850 writes.

### GOOSE and Sampled Values

GOOSE and Sampled Values do not use TCP/IP sockets. They use Ethernet frames directly. For this reason a pure JavaScript adapter cannot fully implement them without native raw Ethernet access.

This adapter currently validates the configuration and writes a diagnostic status below:

```text
iec61850.0.goose.status
iec61850.0.sampledValues.status
```

## States

Important diagnostic states:

```text
iec61850.0.info.connection
iec61850.0.info.mode
iec61850.0.info.services
iec61850.0.diagnostics.status
iec61850.0.diagnostics.lastError
iec61850.0.diagnostics.bytesRx
iec61850.0.diagnostics.bytesTx
iec61850.0.diagnostics.lastFrameHex
iec61850.0.mms.clientConnected
iec61850.0.mms.serverConnections
```

## Troubleshooting

### Client does not connect

- Check the IED IP address.
- Check TCP port `102`.
- Check firewall rules between ioBroker and the IED.
- Some substations restrict MMS clients by IP address.

### Server mode does not start on port 102

TCP ports below `1024` are privileged on Linux. Use port `8102` for tests or grant the needed capability to the Node.js runtime on the target host.

### GOOSE or Sampled Values stay in diagnostic mode

That is expected for this first version. The adapter needs a native raw Ethernet backend before those services can decode or publish real Ethernet frames.

## Changelog

### 0.1.2

- Replace service multiselect with Admin-compatible service checkboxes.

### 0.1.1

- Create info and diagnostic objects before writing startup states.

### 0.1.0

- Initial installable IEC 61850 adapter foundation.
- Add client/server role selection.
- Add MMS TCP client and test server diagnostics.
- Add reports and manual data point state model.
- Add guarded GOOSE and Sampled Values configuration.

## License

MIT

Copyright (c) 2026 TheBam1990
