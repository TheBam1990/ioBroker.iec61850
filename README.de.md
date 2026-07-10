# ioBroker IEC 61850

ioBroker-Adaptergrundlage fuer IEC 61850 mit umschaltbarem Client-/Server-Modus, MMS-TCP-Diagnose, Report-Datenpunkten sowie vorbereiteter GOOSE- und Sampled-Values-Konfiguration.

Englische Dokumentation: [README.md](README.md).

## Aktueller Umfang

Diese erste Testversion ist so gebaut, dass sie sauber in ioBroker installiert werden kann und eine strukturierte IEC-61850-Basis bereitstellt. Enthalten sind:

- Auswahl als Client, Server oder Client + Server.
- MMS-TCP-Client-Verbindung zu einem IEC-61850-Geraet, normalerweise TCP-Port `102`.
- MMS-TCP-Server fuer Labortests, Standard-Port `8102`.
- Konfiguration von Report Control Blocks und ioBroker-Report-Zustaenden.
- Manuelle IEC-61850-Datenpunktzuordnung.
- GOOSE- und Sampled-Values-Konfiguration mit klarer Diagnose.

Vollstaendiges IEC-61850-MMS-Browsing, ASN.1-MMS-Decoding, GOOSE-Senden/Empfangen und Sampled-Values-Decoding benoetigen ein natives IEC-61850-Backend wie libIEC61850 oder eine gleichwertige Systemkomponente. Diese Adapterversion bereitet die ioBroker-Seite vor und liefert bis dahin sichere Diagnosezustaende.

## Anforderungen

- ioBroker mit js-controller 6 oder neuer.
- Node.js 22 oder neuer.
- Fuer MMS-Clientbetrieb: TCP-Zugriff auf das IED oder Gateway.
- Fuer echten MMS-Serverbetrieb auf TCP `102`: Berechtigung fuer privilegierte Ports, alternativ Test-Port `8102`.
- Fuer GOOSE und Sampled Values: Linux Raw-Ethernet-Zugriff, korrektes Netzwerkinterface und spaeter ein natives IEC-61850-Backend.

## Konfiguration

### Allgemein

`Adapter aktivieren` erst einschalten, wenn die Zielwerte passen. Rolle auswaehlen:

- `Client`: verbindet sich zu einem IEC-61850-MMS-Server.
- `Server`: lauscht lokal auf MMS-TCP-Clients.
- `Client + Server`: beides gleichzeitig.

Dienste:

- `MMS`: TCP-basierter Manufacturing Message Specification Transport.
- `Reports`: Zustandsmodell fuer Report Control Blocks.
- `GOOSE`: Raw-Ethernet-Ereignistelegramme.
- `Sampled Values`: Raw-Ethernet-Messwertstroeme.

### MMS

Fuer Client-Modus:

- `MMS-Server Host`: IP-Adresse oder DNS-Name des IED.
- `MMS-Server Port`: normalerweise `102`.
- `Verbindungs-Timeout ms`: Timeout fuer den Verbindungsaufbau.
- `Reconnect-Verzoegerung ms`: Wartezeit bis zum erneuten Verbinden.

Fuer Server-Modus:

- `Server Bind-Adresse`: lokale IP, meistens `0.0.0.0`.
- `Lokaler Server-Port`: `8102` fuer Tests oder `102`, wenn der Host das erlaubt.

### Reports

Jeder Report-Eintrag erzeugt Zustaende unter:

```text
iec61850.0.reports.<id>.enabled
iec61850.0.reports.<id>.reference
iec61850.0.reports.<id>.lastUpdate
iec61850.0.reports.<id>.value
```

Beispiel fuer eine Report-Referenz:

```text
IED1LD0/LLN0.RP.Events
```

### Datenpunkte

Manuelle Datenpunkte erzeugen Zustaende unter:

```text
iec61850.0.points.<id>.value
iec61850.0.points.<id>.reference
iec61850.0.points.<id>.quality
iec61850.0.points.<id>.timestamp
```

Schreibbare Punkte bekommen zusaetzlich:

```text
iec61850.0.points.<id>.set
```

Schreibwerte werden in dieser ersten Version lokal in den ioBroker-Wert uebernommen. Ein spaeteres MMS-Backend kann denselben Zustand fuer echte IEC-61850-Schreibbefehle verwenden.

### GOOSE und Sampled Values

GOOSE und Sampled Values laufen nicht ueber normale TCP/IP-Sockets. Sie nutzen Ethernet-Frames direkt. Deshalb kann ein reiner JavaScript-Adapter diese Dienste ohne nativen Raw-Ethernet-Zugriff nicht vollstaendig implementieren.

Der Adapter prueft aktuell die Konfiguration und schreibt einen Diagnosezustand unter:

```text
iec61850.0.goose.status
iec61850.0.sampledValues.status
```

## Wichtige Zustaende

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

## Fehlersuche

### Client verbindet sich nicht

- IP-Adresse des IED pruefen.
- TCP-Port `102` pruefen.
- Firewall zwischen ioBroker und IED pruefen.
- Manche Anlagen erlauben MMS nur von freigegebenen Client-IP-Adressen.

### Server startet nicht auf Port 102

TCP-Ports unter `1024` sind unter Linux privilegiert. Fuer Tests Port `8102` nutzen oder dem Node.js-Prozess die passende Berechtigung geben.

### GOOSE oder Sampled Values bleiben im Diagnosemodus

Das ist in dieser ersten Version erwartet. Fuer echte Ethernet-Frames braucht der Adapter ein natives Raw-Ethernet-Backend.

## Changelog

### 0.1.2

- Dienst-Mehrfachauswahl durch Admin-kompatible Dienst-Checkboxen ersetzt.

### 0.1.1

- Info- und Diagnoseobjekte werden vor dem Schreiben der Startzustaende angelegt.

### 0.1.0

- Erste installierbare IEC-61850-Adaptergrundlage.
- Client-/Server-Rollenumschaltung.
- MMS-TCP-Client und Testserver-Diagnose.
- Reports und manuelles Datenpunktmodell.
- Abgesicherte GOOSE- und Sampled-Values-Konfiguration.

## Lizenz

MIT

Copyright (c) 2026 TheBam1990
