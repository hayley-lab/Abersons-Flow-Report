import { parseRedisInfo, usageDeltas } from "../kv-usage";

const HOUR = 3600000;

describe("parseRedisInfo", () => {
  it("extracts the tracked counters from INFO text", () => {
    const text = [
      "# Stats",
      "total_commands_processed:4659355",
      "total_reads_processed:3473829\r",
      "total_writes_processed:1185526",
      "total_data_size:315632655",
      "total_keys:1532",
      "used_memory_human:17.019MB",
    ].join("\n");
    expect(parseRedisInfo(text)).toEqual({
      commands: 4659355,
      reads: 3473829,
      writes: 1185526,
      dataBytes: 315632655,
      keys: 1532,
    });
  });

  it("returns an empty object for missing input", () => {
    expect(parseRedisInfo(null)).toEqual({});
  });
});

describe("usageDeltas", () => {
  it("normalises each interval to a per-day rate", () => {
    const deltas = usageDeltas([
      { ts: 12 * HOUR, commands: 1500, reads: 900, writes: 600, dataBytes: 10 },
      { ts: 0, commands: 1000, reads: 600, writes: 400, dataBytes: 9 },
    ]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      hours: 12,
      reset: false,
      commands: 500,
      commandsPerDay: 1000,
      readsPerDay: 600,
      writesPerDay: 400,
      dataBytes: 10,
    });
  });

  it("flags a counter reset instead of reporting a negative rate", () => {
    const [d] = usageDeltas([
      { ts: 0, commands: 5000, reads: 3000, writes: 2000 },
      { ts: 24 * HOUR, commands: 100, reads: 60, writes: 40 },
    ]);
    expect(d.reset).toBe(true);
    expect(d.commandsPerDay).toBeNull();
  });
});
