type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue | undefined>;

type RuntimeIdentity = {
  nodeName: string;
  storageBackend: string;
  redisEnabled: boolean;
  protocol: string;
};

type RuntimeSnapshot = RuntimeIdentity & {
  redisConnected: boolean;
  chats: number;
  activeSockets: number;
  uptimeSec: number;
};

type Sample = {
  labels: Record<string, string>;
  value: number;
};

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function normalizeLabels(labels: Labels = {}): Record<string, string> {
  const normalized: Record<string, string> = {};
  Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => {
      normalized[key] = String(value);
    });
  return normalized;
}

function labelsKey(labels: Record<string, string>): string {
  return JSON.stringify(labels);
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
}

class CounterMetric {
  private readonly values = new Map<string, Sample>();

  inc(labels: Labels = {}, value = 1): void {
    const normalized = normalizeLabels(labels);
    const key = labelsKey(normalized);
    const current = this.values.get(key);
    if (current) {
      current.value += value;
      return;
    }
    this.values.set(key, { labels: normalized, value });
  }

  lines(name: string): string[] {
    if (!this.values.size) return [`${name} 0`];
    return Array.from(this.values.values()).map(
      (sample) => `${name}${renderLabels(sample.labels)} ${sample.value}`,
    );
  }
}

class GaugeMetric {
  private readonly values = new Map<string, Sample>();

  set(labels: Labels = {}, value: number): void {
    const normalized = normalizeLabels(labels);
    this.values.set(labelsKey(normalized), { labels: normalized, value });
  }

  lines(name: string): string[] {
    if (!this.values.size) return [`${name} 0`];
    return Array.from(this.values.values()).map(
      (sample) => `${name}${renderLabels(sample.labels)} ${sample.value}`,
    );
  }
}

type HistogramSample = {
  labels: Record<string, string>;
  buckets: number[];
  count: number;
  sum: number;
};

class HistogramMetric {
  private readonly values = new Map<string, HistogramSample>();

  constructor(private readonly bucketBounds: number[]) {}

  observe(labels: Labels = {}, value: number): void {
    const normalized = normalizeLabels(labels);
    const key = labelsKey(normalized);
    let sample = this.values.get(key);
    if (!sample) {
      sample = {
        labels: normalized,
        buckets: this.bucketBounds.map(() => 0),
        count: 0,
        sum: 0,
      };
      this.values.set(key, sample);
    }

    sample.count += 1;
    sample.sum += value;
    this.bucketBounds.forEach((bound, index) => {
      if (value <= bound) sample!.buckets[index] += 1;
    });
  }

  lines(name: string): string[] {
    if (!this.values.size) {
      return [
        `${name}_bucket{le="+Inf"} 0`,
        `${name}_sum 0`,
        `${name}_count 0`,
      ];
    }

    const lines: string[] = [];
    for (const sample of this.values.values()) {
      this.bucketBounds.forEach((bound, index) => {
        lines.push(
          `${name}_bucket${renderLabels({ ...sample.labels, le: String(bound) })} ${sample.buckets[index]}`,
        );
      });
      lines.push(`${name}_bucket${renderLabels({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
      lines.push(`${name}_sum${renderLabels(sample.labels)} ${sample.sum}`);
      lines.push(`${name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
    return lines;
  }
}

const httpRequests = new CounterMetric();
const socketEvents = new CounterMetric();
const chatMessages = new CounterMetric();
const uploadFailures = new CounterMetric();
const rateLimitHits = new CounterMetric();
const cleanupRuns = new CounterMetric();
const uploadFiles = new CounterMetric();
const uploadBytes = new CounterMetric();
const requestDurationMs = new HistogramMetric([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
const gauges = {
  activeSockets: new GaugeMetric(),
  redisConnected: new GaugeMetric(),
  chats: new GaugeMetric(),
  buildInfo: new GaugeMetric(),
  processStart: new GaugeMetric(),
};

let runtimeIdentity: RuntimeIdentity = {
  nodeName: "share-chat",
  storageBackend: "disk",
  redisEnabled: false,
  protocol: "http",
};

const processStartedAtSeconds = Math.floor(Date.now() / 1000);

export function initializeRuntimeMetrics(identity: RuntimeIdentity): void {
  runtimeIdentity = identity;
  gauges.buildInfo.set(
    {
      node_name: identity.nodeName,
      storage_backend: identity.storageBackend,
      redis_enabled: identity.redisEnabled,
      protocol: identity.protocol,
    },
    1,
  );
  gauges.processStart.set({}, processStartedAtSeconds);
  gauges.redisConnected.set({}, 0);
  gauges.chats.set({}, 0);
  gauges.activeSockets.set({}, 0);
}

export function setRedisConnected(connected: boolean): void {
  gauges.redisConnected.set({}, connected ? 1 : 0);
}

export function setChatCount(count: number): void {
  gauges.chats.set({}, count);
}

export function setActiveSockets(count: number): void {
  gauges.activeSockets.set({}, count);
}

export function recordHttpRequest(method: string, path: string, status: number, durationMs: number): void {
  httpRequests.inc({ method, path, status }, 1);
  requestDurationMs.observe({ method, path }, durationMs);
}

export function recordSocketConnected(): void {
  socketEvents.inc({ event: "connect" }, 1);
}

export function recordSocketDisconnected(reason: string): void {
  socketEvents.inc({ event: "disconnect", reason }, 1);
}

export function recordChatMessage(kind: "text" | "image"): void {
  chatMessages.inc({ kind }, 1);
}

export function recordUploadCompleted(fileCount: number, bytes: number): void {
  uploadFiles.inc({}, fileCount);
  uploadBytes.inc({}, bytes);
}

export function recordUploadFailure(reason: string): void {
  uploadFailures.inc({ reason }, 1);
}

export function recordRateLimitHit(scope: string): void {
  rateLimitHits.inc({ scope }, 1);
}

export function recordCleanupRun(reason: string, result: "ok" | "error"): void {
  cleanupRuns.inc({ reason, result }, 1);
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  const parseValue = (line: string): number => Number(line.split(" ").pop() || 0);
  return {
    ...runtimeIdentity,
    redisConnected: parseValue(gauges.redisConnected.lines("sharechat_redis_connected")[0]) > 0,
    chats: parseValue(gauges.chats.lines("sharechat_chats_total")[0]),
    activeSockets: parseValue(gauges.activeSockets.lines("sharechat_active_socket_connections")[0]),
    uptimeSec: Math.round(process.uptime()),
  };
}

export function renderPrometheusMetrics(): string {
  const sections: string[] = [];
  const push = (name: string, type: "counter" | "gauge" | "histogram", help: string, lines: string[]) => {
    sections.push(`# HELP ${name} ${help}`);
    sections.push(`# TYPE ${name} ${type}`);
    sections.push(...lines);
  };

  push("sharechat_build_info", "gauge", "Static build and runtime identity information.", gauges.buildInfo.lines("sharechat_build_info"));
  push("sharechat_process_start_time_seconds", "gauge", "Unix time when the process started.", gauges.processStart.lines("sharechat_process_start_time_seconds"));
  push("sharechat_active_socket_connections", "gauge", "Currently active WebSocket connections.", gauges.activeSockets.lines("sharechat_active_socket_connections"));
  push("sharechat_redis_connected", "gauge", "Whether Redis connectivity is currently available.", gauges.redisConnected.lines("sharechat_redis_connected"));
  push("sharechat_chats_total", "gauge", "Current number of chats loaded in memory.", gauges.chats.lines("sharechat_chats_total"));
  push("sharechat_http_requests_total", "counter", "HTTP requests observed by the application.", httpRequests.lines("sharechat_http_requests_total"));
  push("sharechat_http_request_duration_ms", "histogram", "HTTP request duration in milliseconds.", requestDurationMs.lines("sharechat_http_request_duration_ms"));
  push("sharechat_socket_events_total", "counter", "Socket lifecycle events.", socketEvents.lines("sharechat_socket_events_total"));
  push("sharechat_chat_messages_total", "counter", "Chat messages sent through Socket.IO.", chatMessages.lines("sharechat_chat_messages_total"));
  push("sharechat_upload_files_total", "counter", "Uploaded files processed by the application.", uploadFiles.lines("sharechat_upload_files_total"));
  push("sharechat_upload_bytes_total", "counter", "Uploaded bytes processed by the application.", uploadBytes.lines("sharechat_upload_bytes_total"));
  push("sharechat_upload_failures_total", "counter", "Upload failures by reason.", uploadFailures.lines("sharechat_upload_failures_total"));
  push("sharechat_rate_limit_hits_total", "counter", "Rate limit hits by scope.", rateLimitHits.lines("sharechat_rate_limit_hits_total"));
  push("sharechat_cleanup_runs_total", "counter", "Upload cleanup runs by reason and result.", cleanupRuns.lines("sharechat_cleanup_runs_total"));

  return `${sections.join("\n")}\n`;
}
