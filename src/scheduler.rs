use chrono::{DateTime, Duration, NaiveDate};
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

fn moment_for(day: NaiveDate, minutes: u32, tz: Tz) -> DateTime<Tz> {
    let naive = day.and_hms_opt(minutes / 60, minutes % 60, 0).unwrap();
    naive.and_local_timezone(tz).single().unwrap()
}

/// Next scheduled run strictly after `now`.
pub fn next_run(now: DateTime<Tz>, schedule: &[u32]) -> DateTime<Tz> {
    let today = now.date_naive();
    let mut candidates: Vec<DateTime<Tz>> = schedule
        .iter()
        .map(|&m| moment_for(today, m, now.timezone()))
        .filter(|c| *c > now)
        .collect();
    if candidates.is_empty() {
        let tomorrow = today + Duration::days(1);
        candidates = schedule
            .iter()
            .map(|&m| moment_for(tomorrow, m, now.timezone()))
            .collect();
    }
    candidates.sort();
    candidates[0]
}

/// Most recent scheduled moment not after `now` (used for catch-up logic).
pub fn last_passed(now: DateTime<Tz>, schedule: &[u32]) -> Option<DateTime<Tz>> {
    let today = now.date_naive();
    let yesterday = today - Duration::days(1);
    let mut all: Vec<DateTime<Tz>> = schedule
        .iter()
        .map(|&m| moment_for(yesterday, m, now.timezone()))
        .chain(schedule.iter().map(|&m| moment_for(today, m, now.timezone())))
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