import { useEffect, useState } from "react";

// Loading overlay content shown while the main process resolves anime sources.
// Subscribes to progress events and renders the lookup steps.

const STEPS = [
  { id: "search", label: "Searching title" },
  { id: "servers", label: "Connecting to servers" },
  { id: "episodes", label: "Loading episode list" },
  { id: "stream", label: "Fetching stream" },
  { id: "player", label: "Starting player" },
];

export default function HiAnimeLoader({
  what = "episode",
  playerStarting,
  provider = "JustAnime",
}) {
  const [stage, setStage] = useState("search");

  useEffect(() => {
    setStage("search");
    const off =
      provider === "JustAnime"
        ? window.electron?.onJustAnimeProgress?.((s) => {
            if (s) setStage(s);
          })
        : window.electron?.onHiAnimeProgress?.((s) => {
            if (s) setStage(s);
          });
    return () => {
      if (typeof off === "function") off();
    };
  }, [provider]);

  const filteredSteps = STEPS.filter((step) =>
    provider === "JustAnime" ? step.id !== "episodes" : step.id !== "servers",
  );

  const current = playerStarting
    ? filteredSteps.length - 1
    : Math.max(
        0,
        filteredSteps.findIndex((s) => s.id === stage),
      );

  return (
    <>
      <div className="spinner" />
      <span style={{ fontSize: 14, color: "var(--text2)" }}>
        Looking up {what} on {provider}…
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 190,
        }}
        role="status"
        aria-live="polite"
      >
        {filteredSteps.map((step, i) => (
          <div
            key={step.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color:
                i < current
                  ? "var(--text2)"
                  : i === current
                    ? "var(--text)"
                    : "var(--text3)",
              opacity: i > current ? 0.5 : 1,
              fontWeight: i === current ? 600 : 400,
            }}
          >
            <span style={{ width: 14, textAlign: "center" }}>
              {i < current ? "✓" : i === current ? "●" : "○"}
            </span>
            {step.label}
          </div>
        ))}
      </div>
    </>
  );
}
