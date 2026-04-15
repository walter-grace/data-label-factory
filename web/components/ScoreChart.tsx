"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

/**
 * Score over time chart — shows each agent's cumulative score
 * as stacked colored areas. Inspired by shadcn/ui area charts
 * and Ant Design's normalize line charts.
 */

type ScoreSnapshot = {
  tick: number;
  [agentId: string]: number;
};

type AgentMeta = {
  id: string;
  name: string;
  color: string;
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload) return null;
  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-xl backdrop-blur-sm">
      <div className="text-[10px] text-zinc-500 mb-2">Tick {label}</div>
      <div className="space-y-1">
        {payload
          .sort((a: any, b: any) => b.value - a.value)
          .map((entry: any) => (
            <div key={entry.name} className="flex items-center justify-between gap-6 text-xs">
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                <span className="text-zinc-300">{entry.name}</span>
              </div>
              <span className="font-bold tabular-nums" style={{ color: entry.color }}>
                {entry.value.toLocaleString()}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
};

export default function ScoreChart({
  data,
  agents,
  height = 280,
}: {
  data: ScoreSnapshot[];
  agents: AgentMeta[];
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center text-zinc-600 text-sm" style={{ height }}>
        Waiting for data...
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
        <defs>
          {agents.map((agent) => (
            <linearGradient key={agent.id} id={`gradient-${agent.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={agent.color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={agent.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.04)"
          vertical={false}
        />
        <XAxis
          dataKey="tick"
          tick={{ fontSize: 10, fill: "#71717a" }}
          axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#71717a" }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          verticalAlign="top"
          height={36}
          formatter={(value: string) => (
            <span className="text-xs text-zinc-400">{value}</span>
          )}
        />
        {agents.map((agent) => (
          <Area
            key={agent.id}
            type="monotone"
            dataKey={agent.id}
            name={agent.name}
            stroke={agent.color}
            strokeWidth={2}
            fill={`url(#gradient-${agent.id})`}
            dot={false}
            activeDot={{ r: 4, fill: agent.color, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
