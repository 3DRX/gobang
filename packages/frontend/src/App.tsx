import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import './App.css'

const BOARD_SIZE = 15
const CLIENT_ID_KEY = 'gobang.clientId'
const DISPLAY_NAME_KEY = 'gobang.displayName'

type Seat = 'black' | 'white'
type Cell = Seat | null
type RoomStatus = 'waiting' | 'playing' | 'finished'
type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'room_full'
  | 'missing'

interface Player {
  seat: Seat
  displayName: string
  connected: boolean
}

interface WinningPoint {
  x: number
  y: number
}

interface PendingPoint extends WinningPoint {
  moveCount: number
  turn: Seat
}

interface PublicMove {
  seat: Seat
  x: number
  y: number
  at: string
  index: number
}

interface GameState {
  roomId: string
  status: RoomStatus
  players: Player[]
  board: Cell[][]
  turn: Seat
  turnDeadlineAt: string | null
  winner: Seat | null
  timedOutSeat: Seat | null
  winningLine: WinningPoint[]
  lastMove: PublicMove | null
  moveCount: number
  createdAt: string
  updatedAt: string
}

type ServerMessage =
  | { type: 'snapshot'; state: GameState; you?: { seat: Seat } }
  | { type: 'error'; code: string; message: string }

interface Route {
  name: 'home' | 'room'
  roomId?: string
}

function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute())

  useEffect(() => {
    const handlePop = () => setRoute(parseRoute())
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [])

  const navigate = (path: string) => {
    window.history.pushState({}, '', path)
    setRoute(parseRoute())
  }

  if (route.name === 'room' && route.roomId) {
    return <RoomScreen navigate={navigate} roomId={route.roomId} />
  }

  return <HomeScreen navigate={navigate} />
}

function HomeScreen({ navigate }: { navigate: (path: string) => void }) {
  const [displayName, setDisplayName] = useState(() => getStoredDisplayName())
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')

  const createRoom = async () => {
    setIsCreating(true)
    setError('')
    storeDisplayName(displayName)

    try {
      const response = await fetch('/api/rooms', { method: 'POST' })
      if (!response.ok) {
        throw new Error('Room creation failed.')
      }
      const room = (await response.json()) as { invitePath: string }
      navigate(room.invitePath)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Room creation failed.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <main className="shell home-shell">
      <section className="home-panel" aria-labelledby="home-title">
        <div className="brand-mark" aria-hidden="true">
          五
        </div>
        <div className="home-copy">
          <p className="eyebrow">Realtime Gobang</p>
          <h1 id="home-title">Create a five-in-a-row room</h1>
          <p className="lede">
            Open a room, share the link, and play a two-person casual Gomoku match on a
            15 by 15 board.
          </p>
        </div>

        <label className="field">
          <span>Display name</span>
          <input
            value={displayName}
            maxLength={24}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Player"
          />
        </label>

        <button className="primary-action" disabled={isCreating} onClick={createRoom} type="button">
          {isCreating ? 'Creating...' : 'Create room'}
        </button>

        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  )
}

function RoomScreen({ roomId, navigate }: { roomId: string; navigate: (path: string) => void }) {
  const [displayName] = useState(() => getStoredDisplayName())
  const [clientId] = useState(() => getClientId())
  const [state, setState] = useState<GameState | null>(null)
  const [seat, setSeat] = useState<Seat | null>(null)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState('')
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [dismissedResultMove, setDismissedResultMove] = useState<number | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<number | null>(null)
  const terminalRef = useRef(false)

  useEffect(() => {
    let stopped = false

    const connect = () => {
      if (stopped || terminalRef.current) {
        return
      }

      setConnection((current) => (current === 'disconnected' ? 'reconnecting' : 'connecting'))
      const socket = new WebSocket(buildWebSocketUrl(roomId))
      socketRef.current = socket

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            type: 'join',
            clientId,
            displayName,
          }),
        )
      })

      socket.addEventListener('message', (event) => {
        const message = parseServerMessage(event.data)
        if (!message) {
          return
        }

        if (message.type === 'error') {
          setError(message.message)
          setPendingPoint(null)
          if (message.code === 'room_full') {
            terminalRef.current = true
            setConnection('room_full')
          }
          if (message.code === 'room_not_found') {
            terminalRef.current = true
            setConnection('missing')
          }
          return
        }

        setError('')
        setState(message.state)
        setSeat(message.you?.seat ?? null)
        setConnection('connected')
      })

      socket.addEventListener('close', () => {
        if (stopped || terminalRef.current) {
          return
        }
        setConnection('disconnected')
        reconnectRef.current = window.setTimeout(connect, 900)
      })

      socket.addEventListener('error', () => {
        setError('Connection interrupted.')
      })
    }

    connect()

    return () => {
      stopped = true
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current)
      }
      socketRef.current?.close()
    }
  }, [clientId, displayName, roomId])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [])

  const winningPoints = useMemo(() => {
    return new Set((state?.winningLine ?? []).map((point) => pointKey(point.x, point.y)))
  }, [state?.winningLine])

  const canPlay = Boolean(
    state && seat && connection === 'connected' && state.status === 'playing' && state.turn === seat && !state.winner,
  )

  const inviteUrl = new URL(`/room/${roomId}`, window.location.href).toString()
  const blackPlayer = state?.players.find((player) => player.seat === 'black') ?? null
  const whitePlayer = state?.players.find((player) => player.seat === 'white') ?? null
  const timeRemainingMs = getTimeRemainingMs(state?.turnDeadlineAt ?? null, now)
  const activePendingPoint =
    pendingPoint &&
    state &&
    canPlay &&
    pendingPoint.moveCount === state.moveCount &&
    pendingPoint.turn === state.turn &&
    !state.board[pendingPoint.y]?.[pendingPoint.x]
      ? pendingPoint
      : null
  const showResultPopup = Boolean(state?.winner && dismissedResultMove !== state.moveCount)

  const placeStone = (x: number, y: number) => {
    if (!canPlay || !state || state.board[y]?.[x]) {
      return
    }

    if (activePendingPoint?.x !== x || activePendingPoint.y !== y) {
      setPendingPoint({ x, y, moveCount: state.moveCount, turn: state.turn })
      return
    }

    setPendingPoint(null)
    socketRef.current?.send(JSON.stringify({ type: 'placeStone', x, y }))
  }

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1500)
  }

  return (
    <main className="shell game-shell">
      <section className="board-zone" aria-label="Gobang board">
        <div className="room-strip">
          <button className="ghost-action" onClick={() => navigate('/')} type="button">
            New room
          </button>
          <div>
            <p className="eyebrow">Room</p>
            <h1>{shortRoomId(roomId)}</h1>
          </div>
        </div>

        <div className="board-wrap">
          <div className="board-grid" role="grid" aria-label="15 by 15 Gobang board">
            {Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
              const x = index % BOARD_SIZE
              const y = Math.floor(index / BOARD_SIZE)
              const cell = state?.board[y]?.[x] ?? null
              const isLast = state?.lastMove?.x === x && state.lastMove.y === y
              const isWinning = winningPoints.has(pointKey(x, y))
              const isTarget = !cell && activePendingPoint?.x === x && activePendingPoint.y === y

              return (
                <button
                  aria-label={
                    cell
                      ? `${cell} stone at ${x + 1}, ${y + 1}`
                      : isTarget
                        ? `Confirm move at ${x + 1}, ${y + 1}`
                        : `Target ${x + 1}, ${y + 1}`
                  }
                  className={[
                    'board-cell',
                    cell ? `stone-${cell}` : '',
                    isTarget ? `is-target target-${seat}` : '',
                    isLast ? 'is-last' : '',
                    isWinning ? 'is-winning' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={!canPlay || Boolean(cell)}
                  key={`${x}-${y}`}
                  onClick={() => placeStone(x, y)}
                  role="gridcell"
                  style={getBoardPointStyle(x, y)}
                  type="button"
                >
                  <span aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <aside className="side-panel" aria-label="Game status">
        <StatusCard
          connection={connection}
          error={error}
          pendingPoint={activePendingPoint}
          seat={seat}
          state={state}
          timeRemainingMs={timeRemainingMs}
        />

        <div className="players">
          <PlayerSeat label="Black" player={blackPlayer} seat="black" selfSeat={seat} />
          <PlayerSeat label="White" player={whitePlayer} seat="white" selfSeat={seat} />
        </div>

        {state?.status === 'waiting' ? (
          <div className="invite-panel">
            <p className="eyebrow">Invite link</p>
            <input readOnly value={inviteUrl} />
            <button className="secondary-action" onClick={copyInvite} type="button">
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy invite'}
            </button>
          </div>
        ) : null}
      </aside>

      {state?.winner && showResultPopup ? (
        <MatchResultPopup
          isWinner={state.winner === seat}
          onClose={() => setDismissedResultMove(state.moveCount)}
          onNewRoom={() => navigate('/')}
          state={state}
        />
      ) : null}
    </main>
  )
}

function MatchResultPopup({
  isWinner,
  onClose,
  onNewRoom,
  state,
}: {
  isWinner: boolean
  onClose: () => void
  onNewRoom: () => void
  state: GameState
}) {
  const winner = state.winner ?? 'black'
  const resultTitle = isWinner ? 'You won' : 'You lost'
  const resultDetail = state.timedOutSeat
    ? `${seatLabel(state.timedOutSeat)} ran out of time.`
    : `${seatLabel(winner)} completed five in a row.`

  return (
    <div className={`result-overlay ${isWinner ? 'is-winner' : ''}`} role="presentation">
      {isWinner ? <CelebrationEffect /> : null}
      <section aria-labelledby="result-title" aria-modal="true" className="result-dialog" role="dialog">
        <div className={`result-stone stone-${winner}`} aria-hidden="true">
          <span />
        </div>
        <p className="eyebrow">Result</p>
        <h2 id="result-title">{resultTitle}</h2>
        <p>{resultDetail}</p>
        <div className="result-actions">
          <button className="primary-action" onClick={onNewRoom} type="button">
            New room
          </button>
          <button className="ghost-action" onClick={onClose} type="button">
            Review board
          </button>
        </div>
      </section>
    </div>
  )
}

function CelebrationEffect() {
  return (
    <div className="celebration-effect" aria-hidden="true">
      {Array.from({ length: 18 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  )
}

function StatusCard({
  connection,
  error,
  pendingPoint,
  seat,
  state,
  timeRemainingMs,
}: {
  connection: ConnectionStatus
  error: string
  pendingPoint: WinningPoint | null
  seat: Seat | null
  state: GameState | null
  timeRemainingMs: number | null
}) {
  const headline = getStatusHeadline(connection, state, seat)
  const detail = getStatusDetail(connection, state, seat, error, pendingPoint)

  return (
    <section className="status-card" aria-live="polite">
      <p className="eyebrow">Status</p>
      <h2>{headline}</h2>
      <p>{detail}</p>
      {state ? (
        <dl className="stats">
          <div>
            <dt>Move</dt>
            <dd>{state.moveCount}</dd>
          </div>
          <div>
            <dt>You</dt>
            <dd>{seat ? seatLabel(seat) : 'Pending'}</dd>
          </div>
          <div>
            <dt>Clock</dt>
            <dd>{formatClock(timeRemainingMs)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  )
}

function PlayerSeat({
  label,
  player,
  seat,
  selfSeat,
}: {
  label: string
  player: Player | null
  seat: Seat
  selfSeat: Seat | null
}) {
  return (
    <section className="player-seat">
      <div className={`seat-stone stone-${seat}`} aria-hidden="true" />
      <div>
        <p className="eyebrow">
          {label}
          {selfSeat === seat ? ' / You' : ''}
        </p>
        <h3>{player?.displayName ?? 'Waiting'}</h3>
        <p>{player ? (player.connected ? 'Connected' : 'Disconnected') : 'Open seat'}</p>
      </div>
    </section>
  )
}

function getStatusHeadline(connection: ConnectionStatus, state: GameState | null, seat: Seat | null): string {
  if (connection === 'room_full') return 'Room full'
  if (connection === 'missing') return 'Room not found'
  if (connection === 'reconnecting') return 'Reconnecting'
  if (connection === 'disconnected') return 'Disconnected'
  if (!state) return 'Connecting'
  if (state.timedOutSeat) return state.timedOutSeat === seat ? 'Timed out' : 'Opponent timed out'
  if (state.winner) return state.winner === seat ? 'You won' : 'Game over'
  if (state.status === 'waiting') return 'Waiting for opponent'
  if (state.turn === seat) return 'Your turn'
  return `${seatLabel(state.turn)} to move`
}

function getStatusDetail(
  connection: ConnectionStatus,
  state: GameState | null,
  seat: Seat | null,
  error: string,
  pendingPoint: WinningPoint | null,
): string {
  if (error && connection !== 'connected') return error
  if (connection === 'room_full') return 'Two players have already claimed this room.'
  if (connection === 'missing') return 'Create a new room or check the invite link.'
  if (connection === 'reconnecting') return 'Trying to restore the live game connection.'
  if (connection === 'disconnected') return 'The socket closed; reconnecting shortly.'
  if (!state) return 'Opening the realtime room.'
  if (state.timedOutSeat) return `${seatLabel(state.timedOutSeat)} ran out of time.`
  if (state.winner) return `${seatLabel(state.winner)} completed five in a row.`
  if (state.status === 'waiting') return 'Share the invite link with one opponent.'
  if (state.turn === seat) {
    return pendingPoint ? 'Tap the target again to place the stone.' : 'Tap an intersection to preview your move.'
  }
  return 'Watch the board while your opponent moves.'
}

function parseRoute(): Route {
  const match = window.location.pathname.match(/^\/room\/([^/]+)$/)
  if (match) {
    return { name: 'room', roomId: decodeURIComponent(match[1]) }
  }
  return { name: 'home' }
}

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') {
    return null
  }

  try {
    return JSON.parse(data) as ServerMessage
  } catch {
    return null
  }
}

function buildWebSocketUrl(roomId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/rooms/${encodeURIComponent(roomId)}`
}

function getClientId(): string {
  const existing = window.localStorage.getItem(CLIENT_ID_KEY)
  if (existing) {
    return existing
  }

  const clientId = window.crypto.randomUUID()
  window.localStorage.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

function getStoredDisplayName(): string {
  return window.localStorage.getItem(DISPLAY_NAME_KEY) ?? 'Player'
}

function storeDisplayName(displayName: string): void {
  window.localStorage.setItem(DISPLAY_NAME_KEY, displayName.trim() || 'Player')
}

function seatLabel(seat: Seat): string {
  return seat === 'black' ? 'Black' : 'White'
}

function getTimeRemainingMs(deadline: string | null, now: number): number | null {
  if (!deadline) {
    return null
  }

  return Math.max(0, Date.parse(deadline) - now)
}

function formatClock(timeRemainingMs: number | null): string {
  if (timeRemainingMs === null) {
    return '--'
  }

  return `${Math.ceil(timeRemainingMs / 1000)}s`
}

function pointKey(x: number, y: number): string {
  return `${x}:${y}`
}

function getBoardPointStyle(x: number, y: number): CSSProperties {
  const intervalCount = BOARD_SIZE - 1
  return {
    left: `${(x / intervalCount) * 100}%`,
    top: `${(y / intervalCount) * 100}%`,
  }
}

function shortRoomId(roomId: string): string {
  return roomId.length > 12 ? `${roomId.slice(0, 6)} ${roomId.slice(-6)}` : roomId
}

export default App
