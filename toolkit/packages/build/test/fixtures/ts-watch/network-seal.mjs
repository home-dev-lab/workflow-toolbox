import net from 'node:net'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'

// Test-owned, unconditional, inherited by every Node child, including red mutations.
const refuse = () => { throw new Error('network is sealed in the tsserver fixture') }
net.Socket.prototype.connect = refuse
net.connect = refuse
net.createConnection = refuse
dgram.createSocket = refuse
syncBuiltinESMExports()
