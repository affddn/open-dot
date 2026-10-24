import SwiftUI

/// One check of the daemon's health report. A status this notch doesn't know reads as unknown.
struct HealthCheck: Decodable, Equatable, Identifiable {
  let id: String
  let status: String
  let summary: String
  var nextStep: String? = nil
  var lastSuccessAt: Double? = nil

  var label: String {
    switch status {
    case "healthy": "Healthy"
    case "stale": "Stale"
    case "failed": "Failed"
    case "not_configured": "Not set up"
    case "disabled": "Off"
    default: "Unknown"
    }
  }

  var color: Color {
    switch status {
    case "healthy": .green
    case "failed": .red
    case "stale", "unknown": .orange
    case "not_configured", "disabled": .secondary
    default: .orange
    }
  }
}

/// The daemon's `GET /health`, the same report as `open-dot doctor --json`. Other keys, such as
/// counts, are left for the CLI.
struct HealthReport: Decodable, Equatable {
  let schemaVersion: Int
  let checkedAt: Double
  /// When the daemon sampled its database for the database checks. Absent without a sample.
  var sampledAt: Double? = nil
  /// Why there's no usable sample: "missing", "expired" or "failed".
  var sampleUnavailable: String? = nil
  let checks: [HealthCheck]
}

/// "Checked just now · database sampled 1m ago", or why there's no sample.
func healthTimes(_ report: HealthReport, now: Date = Date()) -> String {
  let checked = "Checked \(ago(report.checkedAt, now: now))"
  if let sampled = report.sampledAt { return "\(checked) · database sampled \(ago(sampled, now: now))" }
  switch report.sampleUnavailable {
  case "missing": return "\(checked) · no database sample yet"
  case "expired": return "\(checked) · database sample too old"
  case "failed": return "\(checked) · database sample failed"
  default: return "\(checked) · no database sample"
  }
}

/// The health report, as `open-dot doctor` gives it, reached from a dot tab's menu. Read-only:
/// nothing here repairs, starts or restarts anything.
struct HealthView: View {
  let store: Store

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(store.health.map { healthTimes($0) } ?? "Checking…")
            .font(.caption2).foregroundStyle(.secondary)
          Spacer()
          Button("Check again") { Task { await store.refreshHealth() } }
            .buttonStyle(.plain)
            .font(.caption2.weight(.semibold))
            .accessibilityIdentifier("health-refresh")
        }
        if let error = store.healthError {
          Text(error).font(.caption2).foregroundStyle(.red).accessibilityIdentifier("health-error")
        }
        ForEach(store.health?.checks ?? []) { HealthRow(check: $0) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.never)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("health")
  }
}

struct HealthRow: View {
  let check: HealthCheck

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: check.id).font(.caption.weight(.medium))
        Spacer()
        Text(check.label).font(.caption2.weight(.semibold)).foregroundStyle(check.color)
      }
      Text(verbatim: check.summary).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
      if let last = check.lastSuccessAt {
        Text(verbatim: "Last success \(ago(last))").font(.caption2).foregroundStyle(.tertiary)
      }
      if let next = check.nextStep {
        Text(verbatim: "Next: \(next)").font(.caption2).textSelection(.enabled)
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("health-\(check.id)")
  }
}
