import {
  Activity,
  BarChart3,
  Clock3,
  Globe2,
  Grid2X2,
  List,
  MapPin,
  Paintbrush2,
  Sparkles,
  TrendingUp,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

type CountryView = "list" | "grid";

export function ActivityPanel() {
  const {
    pps,
    pulseHistory,
    activeCountries,
    activityEvents,
    countries,
    world,
    user,
    playerLeaderboard,
    setPanel,
  } = useStore();
  const [countryView, setCountryView] = useState<CountryView>("list");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel("none");
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [setPanel]);

  const peakPps = Math.max(0, ...pulseHistory);
  const chartMax = Math.max(1, peakPps);
  const liveCountries = activeCountries.filter(([id]) => countries.has(id));
  const recent = [...activityEvents].reverse().slice(0, 7);
  const personal = useMemo(
    () => (user ? playerLeaderboard.find(([id]) => id === user.id) : undefined),
    [playerLeaderboard, user],
  );
  const yourCumulative = personal?.[2] ?? user?.cumulative ?? 0;
  const yourHeld = personal?.[3] ?? user?.held ?? 0;
  const yourStreak = personal?.[4] ?? user?.streakDays ?? 0;

  return (
    <aside className="cp-activity-panel cp-card" aria-labelledby="activity-title">
      <header className="cp-activity-head">
        <span className="cp-activity-title-icon" aria-hidden><Activity size={18} /></span>
        <h2 id="activity-title">Live activity</h2>
        <button className="cp-panel-icon-btn" aria-label="Close activity" title="Close" onClick={() => setPanel("none")}>
          <X size={18} />
        </button>
      </header>

      <div className="cp-activity-scroll">
        <section className="cp-activity-stats" aria-label="Activity overview">
          <ActivityStat icon={<TrendingUp />} label="Right now" value={`${pps}`} suffix="px/s" live={pps > 0} />
          <ActivityStat icon={<Globe2 />} label="Painted worldwide" value={compact(world)} suffix="pixels" />
          <ActivityStat icon={<MapPin />} label="Active countries" value={`${liveCountries.length}`} suffix="last minute" />
          <ActivityStat
            icon={user ? <UserRound /> : <Sparkles />}
            label="Your contribution"
            value={user ? compact(yourCumulative) : "—"}
            suffix={user ? "pixels" : "Sign in to track"}
          />
        </section>

        <section className="cp-activity-section">
          <div className="cp-activity-section-head">
            <div><BarChart3 size={16} /><h3>Last 60 seconds</h3></div>
            <span>Peak {peakPps} px/s</span>
          </div>
          <div className="cp-activity-chart" role="img" aria-label={`Paint rate over the last minute, peaking at ${peakPps} pixels per second`}>
            {Array.from({ length: 60 }, (_, index) => {
              const offset = 60 - pulseHistory.length;
              const value = index >= offset ? pulseHistory[index - offset] ?? 0 : 0;
              return <span key={index} style={{ height: `${Math.max(value > 0 ? 7 : 2, (value / chartMax) * 100)}%` }} />;
            })}
          </div>
          <div className="cp-activity-chart-axis"><span>60s ago</span><span>Now</span></div>
        </section>

        <section className="cp-activity-section">
          <div className="cp-activity-section-head">
            <div><Globe2 size={16} /><h3>Active countries</h3></div>
            <div className="cp-view-switch" aria-label="Country display" role="group">
              <button aria-label="Show country list" title="List view" aria-pressed={countryView === "list"} onClick={() => setCountryView("list")}><List size={15} /></button>
              <button aria-label="Show country tiles" title="Tile view" aria-pressed={countryView === "grid"} onClick={() => setCountryView("grid")}><Grid2X2 size={14} /></button>
            </div>
          </div>
          {liveCountries.length ? (
            <div className={`cp-active-countries is-${countryView}`}>
              {liveCountries.map(([id, count], index) => {
                const country = countries.get(id)!;
                const share = Math.max(4, (count / liveCountries[0]![1]) * 100);
                return (
                  <div className="cp-active-country" key={id}>
                    <span className="cp-country-rank">{index + 1}</span>
                    <CountryFlag iso={country.iso_a2} flag={country.flag} className="cp-activity-flag" />
                    <div className="cp-active-country-copy"><strong>{country.name}</strong><span>{count.toLocaleString()} paints</span></div>
                    <div className="cp-country-share" aria-hidden><span style={{ width: `${share}%` }} /></div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyState icon={<Globe2 />} text="No country activity in the last minute" />}
        </section>

        <section className="cp-activity-section">
          <div className="cp-activity-section-head">
            <div><Clock3 size={16} /><h3>Recent activity</h3></div>
            <span>Live sample</span>
          </div>
          {recent.length ? (
            <ol className="cp-activity-timeline">
              {recent.map((event) => {
                const country = countries.get(event.countryId);
                if (!country) return null;
                return (
                  <li key={event.id}>
                    <span className="cp-timeline-icon"><Paintbrush2 size={14} /></span>
                    <CountryFlag iso={country.iso_a2} flag={country.flag} className="cp-activity-flag" />
                    <span><strong>{country.name}</strong><small>{event.count} {event.count === 1 ? "paint" : "paints"} landed</small></span>
                    <time dateTime={new Date(event.at).toISOString()}>{relativeTime(event.at)}</time>
                  </li>
                );
              })}
            </ol>
          ) : <EmptyState icon={<Clock3 />} text="New paints will appear here" />}
        </section>

        <section className="cp-activity-section cp-personal-activity">
          <div className="cp-activity-section-head"><div><UserRound size={16} /><h3>Your activity</h3></div></div>
          {user ? (
            <div className="cp-personal-stats">
              <span><strong>{yourCumulative.toLocaleString()}</strong><small>All-time paints</small></span>
              <span><strong>{yourHeld.toLocaleString()}</strong><small>Pixels held</small></span>
              <span><strong>{yourStreak}</strong><small>Day streak</small></span>
            </div>
          ) : (
            <button className="cp-activity-sign-in" onClick={() => setPanel("account")}>
              <span><UserRound size={16} /></span>
              <span><strong>Track your contribution</strong><small>Sign in to see your paints, pixels held, and streak</small></span>
              <span aria-hidden>→</span>
            </button>
          )}
        </section>
      </div>
    </aside>
  );
}

function ActivityStat({ icon, label, value, suffix, live = false }: { icon: React.ReactNode; label: string; value: string; suffix: string; live?: boolean }) {
  return (
    <div className={live ? "cp-activity-stat is-live" : "cp-activity-stat"}>
      <span className="cp-activity-stat-icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{suffix}</small>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="cp-activity-empty">{icon}<span>{text}</span></div>;
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
