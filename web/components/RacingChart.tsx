"use client";

/**
 * Racing Bar Chart — live leaderboard where bars animate, reorder,
 * and grow as agents compete. Pure CSS transitions, no charting library.
 *
 * Each bar smoothly slides to its new rank position and grows/shrinks
 * as the score changes. Like the viral YouTube "top 10 GDP" racing charts.
 */

type RacerData = {
  id: string;
  name: string;
  score: number;
  avatar: string;
  color: string;
  streak: number;
  labels: number;
  type: string;
  isActive?: boolean;
  lastCorrect?: boolean;
};

const RANK_LABELS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];

export default function RacingChart({
  racers,
  maxVisible = 10,
}: {
  racers: RacerData[];
  maxVisible?: number;
}) {
  const sorted = [...racers]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxVisible);

  const maxScore = Math.max(...sorted.map((r) => r.score), 1);

  return (
    <div className="space-y-1.5">
      {sorted.map((racer, rank) => {
        const barWidth = Math.max(8, (racer.score / maxScore) * 100);
        const isLeader = rank === 0 && racer.score > 0;
        const isTop3 = rank < 3 && racer.score > 0;

        return (
          <div
            key={racer.id}
            className="group relative flex items-center gap-3 transition-all duration-700 ease-out"
            style={{
              // CSS order for smooth reordering (flexbox respects order)
              order: rank,
              // Slight scale pulse when active
              transform: racer.isActive ? "scale(1.01)" : "scale(1)",
            }}
          >
            {/* Rank number */}
            <div className={`w-7 shrink-0 text-right text-sm font-bold ${
              rank === 0 ? "text-yellow-400" :
              rank === 1 ? "text-zinc-300" :
              rank === 2 ? "text-amber-600" :
              "text-zinc-600"
            }`}>
              {rank + 1}
            </div>

            {/* Avatar */}
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-black transition-all duration-300 ${
                racer.isActive ? "ring-2 ring-white/30 scale-110" : ""
              }`}
              style={{ backgroundColor: racer.color + "30", color: racer.color }}
            >
              {racer.avatar}
            </div>

            {/* Bar container */}
            <div className="flex-1 relative h-9">
              {/* Bar fill */}
              <div
                className={`absolute inset-y-0 left-0 rounded-lg transition-all duration-700 ease-out ${
                  racer.lastCorrect === false ? "opacity-70" : ""
                }`}
                style={{
                  width: `${barWidth}%`,
                  background: isLeader
                    ? `linear-gradient(90deg, ${racer.color}40, ${racer.color}80)`
                    : `linear-gradient(90deg, ${racer.color}20, ${racer.color}50)`,
                  boxShadow: isLeader ? `0 0 20px ${racer.color}20` : "none",
                }}
              >
                {/* Shine effect on leader */}
                {isLeader && (
                  <div className="absolute inset-0 overflow-hidden rounded-lg">
                    <div className="absolute inset-0 -translate-x-full animate-[shine_3s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                  </div>
                )}
              </div>

              {/* Name + stats overlay */}
              <div className="absolute inset-0 flex items-center justify-between px-3">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${isTop3 ? "text-white" : "text-zinc-300"}`}>
                    {racer.name}
                  </span>
                  <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9px] text-zinc-500 uppercase">
                    {racer.type}
                  </span>
                  {racer.streak >= 3 && (
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                      racer.streak >= 10 ? "bg-red-500/30 text-red-400 animate-pulse" :
                      racer.streak >= 5 ? "bg-orange-500/30 text-orange-400" :
                      "bg-yellow-500/30 text-yellow-400"
                    }`}>
                      {racer.streak}x
                    </span>
                  )}
                  {racer.isActive && racer.lastCorrect !== undefined && (
                    <span className={`text-[10px] font-bold ${
                      racer.lastCorrect ? "text-emerald-400" : "text-red-400"
                    }`}>
                      {racer.lastCorrect ? "+correct" : "missed"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-500">{racer.labels} labels</span>
                  <span className={`text-sm font-bold tabular-nums ${
                    isLeader ? "text-yellow-400" : "text-zinc-200"
                  }`}>
                    {racer.score.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <style jsx>{`
        @keyframes shine {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}
