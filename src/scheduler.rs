use chrono::{DateTime, Duration, LocalResult, NaiveDate};
use chrono_tz::Tz;

/// Parse "HH:MM" into minutes since midnight.
pub fn parse_time(s: &str) -> Option<u32> {
    let t: Vec<&str> = s.trim().split(':').collect();
    if t.len() != 2 {
        return None;
    }
    let h: u32 = t[0].parse().ok()?;
    let m: u32 = t[1].parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// Evenly distributed run minutes across a day, anchored at the base time.
pub fn schedule_minutes(base: &str, per_day: u32) -> Vec<u32> {
    let base_min = parse_time(base).unwrap_or(3 * 60 + 30);
    let n = per_day.max(1);
    let step = 1440 / n;
    (0..n).map(|k| (base_min + k * step) % 1440).collect()
}

/// Build the instant for a local wall-clock time on a given day.
///
/// Returns `None` when the local time does not exist (DST spring-forward gap),
/// so callers can skip that slot instead of panicking. During a DST fall-back
/// the clock repeats and the time exists twice; the earliest occurrence is used.
fn moment_for(day: NaiveDate, minutes: u32, tz: Tz) -> Option<DateTime<Tz>> {
    let naive = day.and_hms_opt(minutes / 60, minutes % 60, 0)?;
    match naive.and_local_timezone(tz) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt, _) => Some(dt),
        LocalResult::None => None,
    }
}

/// Next scheduled run strictly after `now`.
pub fn next_run(now: DateTime<Tz>, schedule: &[u32]) -> DateTime<Tz> {
    let today = now.date_naive();
    let mut candidates: Vec<DateTime<Tz>> = schedule
        .iter()
        .filter_map(|&m| moment_for(today, m, now.timezone()))
        .filter(|c| *c > now)
        .collect();
    if candidates.is_empty() {
        let tomorrow = today + Duration::days(1);
        candidates = schedule
            .iter()
            .filter_map(|&m| moment_for(tomorrow, m, now.timezone()))
            .collect();
    }
    candidates.sort();
    // A slot may be skipped on a DST day, and an empty schedule is possible if
    // misconfigured; wait a short while instead of panicking on an empty list.
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| now + Duration::hours(1))
}

/// Most recent scheduled moment not after `now` (used for catch-up logic).
pub fn last_passed(now: DateTime<Tz>, schedule: &[u32]) -> Option<DateTime<Tz>> {
    let today = now.date_naive();
    let yesterday = today - Duration::days(1);
    let mut all: Vec<DateTime<Tz>> = schedule
        .iter()
        .filter_map(|&m| moment_for(yesterday, m, now.timezone()))
        .chain(schedule.iter().filter_map(|&m| moment_for(today, m, now.timezone())))
        .collect();
    all.sort();
    all.into_iter().rev().find(|c| *c <= now)
}

/// True if we are after a missed slot today within the window and the last
/// successful run predates that slot.
pub fn should_catch_up(
    now: DateTime<Tz>,
    schedule: &[u32],
    window_minutes: i64,
    last_success: Option<&DateTime<Tz>>,
) -> bool {
    let Some(slot) = last_passed(now, schedule) else {
        return false;
    };
    let mins_since = (now - slot).num_minutes();
    if mins_since < 0 || mins_since > window_minutes {
        return false;
    }
    match last_success {
        Some(last) => *last < slot,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ny() -> Tz {
        chrono_tz::America::New_York
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Tz> {
        ny().with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn spring_forward_gap_has_no_instant() {
        // 2024-03-10 in America/New_York: 02:00 jumps straight to 03:00, so the
        // 02:30 wall-clock time does not exist.
        let day = NaiveDate::from_ymd_opt(2024, 3, 10).unwrap();
        assert!(moment_for(day, 2 * 60 + 30, ny()).is_none());
    }

    #[test]
    fn fall_back_ambiguous_uses_earliest_occurrence() {
        // 2024-11-03: 01:30 occurs twice; the earliest is EDT (-04:00).
        let day = NaiveDate::from_ymd_opt(2024, 11, 3).unwrap();
        let dt = moment_for(day, 90, ny()).expect("01:30 should resolve to an instant");
        assert_eq!(dt.format("%Y-%m-%dT%H:%M:%S%:z").to_string(), "2024-11-03T01:30:00-04:00");
    }

    #[test]
    fn next_run_skips_dst_gap_without_panicking() {
        let now = at(2024, 3, 10, 1, 0); // 01:00 EST, before the gap
        let next = next_run(now, &[150]); // 02:30, nonexistent today -> tomorrow
        assert_eq!(next.format("%Y-%m-%d %H:%M").to_string(), "2024-03-11 02:30");
    }

    #[test]
    fn next_run_with_empty_schedule_does_not_panic() {
        let now = at(2024, 3, 10, 1, 0);
        let next = next_run(now, &[]);
        assert!(next > now, "fallback must be scheduled in the future");
    }

    #[test]
    fn last_passed_handles_gap_without_panicking() {
        let now = at(2024, 3, 10, 4, 0);
        // Schedule contains a gap slot (02:30) plus a valid one (06:00).
        let _ = last_passed(now, &[150, 6 * 60]);
    }
}