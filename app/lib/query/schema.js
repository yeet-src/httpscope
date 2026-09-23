/* What an agent can ask httpscope, as a GraphQL schema.
 *
 * The same language as the system graph (`yeet.graph.query`), so one
 * page of SDL is the whole contract: services this machine calls or
 * serves, their endpoints with shapes and statistics, the drift events,
 * and the recent transactions behind them. Read-only.
 *
 * Nothing here is a verdict. Every metric an agent might judge by is a
 * plain number or fact — error rate, tail ratio, key presence, which
 * transport carried an Authorization header — and `where` composes
 * comparisons on them with and/or/not, so the criteria are the agent's.
 * Times are milliseconds since the epoch with an `ago` in seconds
 * beside them; durations in arguments are seconds.
 */

export const SDL = /* GraphQL */ `
"""
Keep the row only when this field's value passes every comparison given.
On a field inside a list, a failing row is dropped; elsewhere it becomes null.
  endpoints { path errorRate @when(gt: 0.05) }
"""
directive @when(eq: JSON, ne: JSON, gt: Float, gte: Float, lt: Float, lte: Float, like: String, in: [JSON!]) on FIELD

"""Replace this field's value by it minus a sibling field (by alias or name, selected earlier in the row) or a constant."""
directive @minus(field: String, by: Float) on FIELD
"""…plus…"""
directive @plus(field: String, by: Float) on FIELD
"""…times…"""
directive @times(field: String, by: Float) on FIELD
"""…divided by…  tail: p99 @div(field: "p50")"""
directive @div(field: String, by: Float) on FIELD

"""Which side of the wire this machine was on."""
enum Role {
  """This machine made the request."""
  CLIENT
  """This machine answered it."""
  SERVER
}

enum EndpointSort {
  """Most transactions first (default)."""
  COUNT
  """Slowest p95 first."""
  LATENCY
  """Most recently seen first."""
  RECENT
  """Most error responses (status >= 400) first."""
  ERRORS
  """By service, then method, then path."""
  NAME
}

"""Which tap saw a transaction."""
enum Transport {
  """Plain TCP off the wire (TCX)."""
  WIRE
  """Plaintext inside a TLS library."""
  TLS
  """Plain TCP at the socket (the older tap)."""
  TCP
}

"""A numeric metric of an endpoint, for \`where\` and \`orderBy\`."""
enum EndpointMetric {
  N
  ERRORS
  ERROR_RATE
  CLIENT_ERRORS
  SERVER_ERRORS
  NOT_FOUND
  INCOMPLETE
  INCOMPLETE_RATE
  P50
  P95
  P99
  MAX
  MEAN
  """p99 / p50: how heavy the tail is."""
  TAIL_RATIO
  """Most calls seen within one second."""
  BURST_MAX
  """Seconds since last seen."""
  LAST_AGO
  """Seconds since first seen."""
  AGE
  """Distinct status codes."""
  STATUS_COUNT
  """Distinct response body shapes (one per status)."""
  RESPONSE_SHAPES
  """Lowest key presence in the main response body (1 = every sample had every key)."""
  KEY_PRESENCE_MIN
  """Keys in the main response body with more than one type."""
  KEYS_MIXED
  """Drift events on this endpoint."""
  DRIFT
  REQUEST_BODY_P95
  RESPONSE_BODY_P95
}

"""A comparison on one metric. Several fields are and-ed."""
input Num {
  eq: Float
  ne: Float
  gt: Float
  gte: Float
  lt: Float
  lte: Float
}

"""A comparison on a string. \`like\` takes * as a wildcard."""
input Str {
  eq: String
  ne: String
  like: String
  in: [String!]
}

"""One metric compared."""
input MetricIs {
  metric: EndpointMetric!
  is: Num!
}

"""
Criteria on endpoints; every field is and-ed, and \`and\`/\`or\`/\`not\` nest.
E.g. an error rate over 5% with at least 20 calls:
  { metrics: [{ metric: ERROR_RATE, is: { gt: 0.05 } }, { metric: N, is: { gte: 20 } }] }
"""
input EndpointWhere {
  role: Role
  service: Str
  method: Str
  path: Str
  metrics: [MetricIs!]
  """Has answered with this status."""
  status: Int
  """Has answered with a status in this range (inclusive)."""
  statusBetween: [Int!]
  """A request header name seen (lower-case)."""
  requestHeader: String
  """A response header name seen (lower-case)."""
  responseHeader: String
  """Seen over this transport."""
  transport: Transport
  """Has a query parameter of this name."""
  queryParam: String
  """The path has an identifier segment ({n}, {uuid}, …)."""
  templated: Boolean
  """The path has a collapsed segment ({*}): a vocabulary, not an id."""
  collapsed: Boolean
  """Response bodies arrived compressed and were not read."""
  bodyUnread: Boolean
  """Had drift of one of these kinds…"""
  driftKinds: [String!]
  """…within this many seconds."""
  driftSince: Float
  and: [EndpointWhere!]
  or: [EndpointWhere!]
  not: EndpointWhere
}

input OrderBy {
  metric: EndpointMetric!
  desc: Boolean = true
}

"""Criteria on recent transactions; fields are and-ed."""
input TransactionWhere {
  role: Role
  service: Str
  method: Str
  """The templated path."""
  path: Str
  """The raw target, with query string."""
  target: Str
  status: Int
  statusBetween: [Int!]
  """Duration in ms."""
  duration: Num
  pid: Int
  transport: Transport
  complete: Boolean
  """Seconds back from now."""
  since: Float
  requestHeader: String
  responseHeader: String
  """A substring of the response body."""
  responseBodyContains: String
  requestBodyContains: String
}

"""Arbitrary JSON: inferred body schemas, raw counters."""
scalar JSON

type Query {
  """Totals and the time of this answer."""
  summary: Summary!
  """The APIs seen: a service is the Host called (or answered as)."""
  services(role: Role, name: String): [Service!]!
  """Endpoints: method × templated path, with shapes and statistics. The simple arguments and \`where\` are and-ed; \`orderBy\` wins over \`sort\`."""
  endpoints(service: String, role: Role, method: String, path: String, status: Int, minCount: Int, since: Float, where: EndpointWhere, sort: EndpointSort = COUNT, orderBy: OrderBy, limit: Int = 100): [Endpoint!]!
  """The most recent transactions (a bounded ring, newest first), with headers and up to 4 KiB of each body — the evidence behind an endpoint's numbers."""
  transactions(where: TransactionWhere, limit: Int = 50, bodyBytes: Int = 4096): [Transaction!]!
  """One endpoint in full, by its identity."""
  endpoint(service: String!, method: String!, path: String!, role: Role = CLIENT): Endpoint
  """Shape changes, oldest first. \`since\` is seconds; \`kinds\` filters by event kind."""
  drift(since: Float, kinds: [String!], service: String, path: String, limit: Int = 200): [DriftEvent!]!
}

type Summary {
  at: Float!
  transactions: Int!
  """Transactions with no request seen (joined mid-exchange)."""
  skipped: Int!
  services: Int!
  endpoints: Int!
  drift: Int!
  """Compressed bodies inflated to learn their shape."""
  inflated: Int!
}

type Service {
  role: Role!
  """The Host header, default port stripped; else the peer address."""
  name: String!
  endpoints: Int!
  transactions: Int!
  """Processes that made the requests, as comm:pid."""
  clients: [String!]!
  """Processes that answered, as comm:pid."""
  servers: [String!]!
  firstAt: Float!
  lastAt: Float!
  lastAgo: Float!
  """Aggregates over the service's endpoints, for comparing one against the rest."""
  stats: ServiceStats!
}

type ServiceStats {
  transactions: Int!
  errors: Int!
  errorRate: Float!
  """Median of the endpoints' p50s and p95s, and the worst p95."""
  p50Median: Float
  p95Median: Float
  p95Max: Float
  """Endpoints seen over plaintext (wire or tcp)."""
  plaintextEndpoints: Int!
}

type Endpoint {
  """Opaque identity, stable across queries."""
  key: String!
  role: Role!
  service: String!
  method: String!
  """The templated path: /users/{n}, /api/{*}."""
  path: String!
  """Transactions seen."""
  n: Int!
  """Seen only in part (cut by a hole, a close, a desync)."""
  incomplete: Int!
  statuses: [StatusCount!]!
  """Responses with status >= 400."""
  errors: Int!
  errorRate: Float!
  clientErrors: Int!
  serverErrors: Int!
  notFound: Int!
  incompleteRate: Float!
  latency: Latency!
  """p99 / p50."""
  tailRatio: Float
  """Most calls seen within one second."""
  burstMax: Int!
  """Which taps saw it, with counts."""
  transports: [TransportCount!]!
  """Processes on this machine's side, as comm:pid."""
  pids: [String!]!
  query: [QueryParam!]!
  """Every metric, by name, for reading many at once."""
  metric(name: EndpointMetric!): Float
  """Drift events on this endpoint, oldest first."""
  drift(since: Float, kinds: [String!]): [DriftEvent!]!
  request: RequestShape!
  """One per status code answered with."""
  responses: [ResponseShape!]!
  firstAt: Float!
  lastAt: Float!
  lastAgo: Float!
}

type StatusCount {
  status: Int!
  count: Int!
}

type TransportCount {
  transport: Transport!
  count: Int!
}

type HeaderCount {
  name: String!
  count: Int!
}

"""One key of a JSON body, flattened: \`$.items[].id\`."""
type KeyStat {
  path: String!
  """Samples of the parent that had this key, over samples of the parent: 1 means always present."""
  presence: Float!
  """Types seen at this key."""
  types: [String!]!
  """Distinct values, when few enough to be an enumeration."""
  values: [String!]
  count: Int!
}

"""Milliseconds, from a reservoir of recent samples."""
type Latency {
  n: Int!
  mean: Float
  p50: Float
  p95: Float
  p99: Float
  max: Float
}

type QueryParam {
  name: String!
  """Requests carrying it."""
  n: Int!
  """Value kinds seen: int, bool, uuid, list, string, …"""
  kinds: [KindCount!]!
}

type KindCount {
  kind: String!
  count: Int!
}

type RequestShape {
  """Content types seen, most common first."""
  contentTypes: [String!]!
  """Header names seen (lower-case), most common first."""
  headers: [String!]!
  headerCounts: [HeaderCount!]!
  body: BodyShape!
}

type ResponseShape {
  status: Int!
  contentTypes: [String!]!
  headers: [String!]!
  headerCounts: [HeaderCount!]!
  body: BodyShape!
}

type BodyShape {
  """JSON bodies learned."""
  n: Int!
  """Non-JSON text bodies seen."""
  text: Int!
  """The learned JSON shape as a type, e.g. { id: number, tags?: string[] }."""
  shape: String
  """The learned JSON schema: { n, types, keys, items, values }."""
  schema: JSON
  """The schema flattened to one row per key, to filter on presence and types."""
  keys(maxDepth: Int = 4): [KeyStat!]!
  """A recent body, up to 1 KiB."""
  example: String
  """Bodies that arrived compressed and could not be read, by Content-Encoding."""
  encoded: JSON!
  """Bodies inflated before learning."""
  inflated: Int!
  """Body sizes in bytes."""
  bytes: Latency!
}

"""One request and its response, as captured."""
type Transaction {
  at: Float!
  ago: Float!
  role: Role!
  service: String!
  method: String!
  """The templated path this counted under."""
  path: String!
  """The raw target, with its query string."""
  target: String!
  status: Int
  """Milliseconds from first request byte to last response byte."""
  duration: Float
  transport: Transport!
  pid: Int
  comm: String
  peer: String
  complete: Boolean!
  """Why it was not seen whole, when it was not."""
  cut: String
  requestHeaders: [Header!]!
  responseHeaders: [Header!]!
  """The request body as text — inflated if it was compressed — up to \`bodyBytes\` (16 KiB at most)."""
  requestBody: String
  """Its full length on the wire."""
  requestBodyLength: Int!
  responseBody: String
  responseBodyLength: Int!
}

type Header {
  name: String!
  value: String!
}

type DriftEvent {
  at: Float!
  ago: Float!
  """endpoint.new, endpoint.collapsed, status.new, query.new, latency.up, latency.back, request.header.new, response.header.new, response.field.added, response.field.missing, response.type.changed, request.field.added, …"""
  kind: String!
  role: Role!
  service: String!
  method: String!
  path: String!
  detail: String!
}
`;
