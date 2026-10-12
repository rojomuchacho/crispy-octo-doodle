#!/usr/bin/env python3
"""Build the game's real-data files from public play-by-play.

Inputs (download into DATA_DIR first; see README "Data"):
  nflverse:   pbp/play_by_play_{2023..2026}.csv.gz, pbp_participation/pbp_participation_{2023..2025}.csv,
              teams/teams_colors_logos.csv
  cfbfastR:   sportsdataverse-data cfbfastR_cfb_pbp/play_by_play_{2024..2026}.parquet

Outputs (JavaScript globals, loaded by index.html):
  js/data/nfl.js   NFL_DATA  real play banks, sack rates, FG/XP/2pt/punt, 4th-down conversion,
                             EP table, win-probability model, team ratings and colors
  js/data/cfb.js   CFB_DATA  the same for college (no coverage tags or team picker)
  js/data/moments.js  AUTO_MOMENTS + MOMENT_FACTS  generated 2026 decisions and exact facts for
                             the hand-picked Real Moments

Usage: python3 scripts/build_data.py DATA_DIR
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "js" / "data"
OUT.mkdir(parents=True, exist_ok=True)
RNG = np.random.default_rng(2026)

# ---------------------------------------------------------------- helpers

def clean_desc(d):
    """Shorten an nflverse play description for the in-game log."""
    if not isinstance(d, str):
        return ""
    d = re.sub(r"^\(\d+:\d+\)\s*", "", d)
    d = re.sub(r"\((Shotgun|No Huddle|No Huddle, Shotgun|Run formation|Pass formation)\)\s*", "", d)
    d = re.sub(r"\b\d{1,2}-(?=[A-Z])", "", d)          # jersey numbers: 15-P.Mahomes -> P.Mahomes
    d = re.sub(r"\s*\([^)]*\)\.?$", ".", d)            # trailing tackler list
    d = re.sub(r"\s+", " ", d).strip()
    return d[:140]


def bucket_dist(d):
    for i, hi in enumerate([1, 2, 3, 5, 7, 10, 15]):
        if d <= hi:
            return i
    return 7


def fit_logistic(X, y, w=None, iters=60, l2=1e-4):
    """Newton/IRLS logistic regression that accepts soft targets in [0, 1]."""
    n, k = X.shape
    if w is None:
        w = np.ones(n)
    beta = np.zeros(k)
    for _ in range(iters):
        z = np.clip(X @ beta, -30, 30)
        p = 1 / (1 + np.exp(-z))
        g = X.T @ (w * (p - y)) + l2 * beta
        H = (X * (w * p * (1 - p))[:, None]).T @ X + l2 * np.eye(k)
        step = np.linalg.solve(H, g)
        beta -= step
        if np.abs(step).max() < 1e-7:
            break
    return beta


def rnd(x, n=3):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), n)


FLAG_INC, FLAG_INT, FLAG_FUM, FLAG_OOB, FLAG_TD = 1, 2, 4, 8, 16


def pack(df, yards="yards_gained", desc="desc", epa="epa"):
    """Rows -> [yards, flags, epa, desc]."""
    out = []
    for r in df.itertuples(index=False):
        f = 0
        f |= FLAG_INC if getattr(r, "inc", 0) == 1 else 0
        f |= FLAG_INT if getattr(r, "int_", 0) == 1 else 0
        f |= FLAG_FUM if getattr(r, "fum", 0) == 1 else 0
        f |= FLAG_OOB if getattr(r, "oob", 0) == 1 else 0
        f |= FLAG_TD if getattr(r, "td", 0) == 1 else 0
        out.append([int(getattr(r, yards)), f, rnd(getattr(r, epa), 2), getattr(r, desc)])
    return out


def sample(df, n):
    return df if len(df) <= n else df.sample(n, random_state=7)


# ---------------------------------------------------------------- NFL

print("NFL: loading play-by-play…")
cols = ["game_id", "play_id", "season", "week", "season_type", "home_team", "away_team", "posteam", "defteam",
        "posteam_type", "qtr", "time", "down", "ydstogo", "yardline_100", "game_seconds_remaining",
        "half_seconds_remaining", "score_differential", "posteam_score", "defteam_score",
        "posteam_timeouts_remaining", "defteam_timeouts_remaining", "play_type", "desc", "yards_gained",
        "pass_location", "air_yards", "run_location", "run_gap", "complete_pass", "incomplete_pass",
        "interception", "sack", "fumble_lost", "out_of_bounds", "qb_spike", "qb_kneel", "qb_scramble",
        "touchdown", "field_goal_result", "kick_distance", "return_yards", "touchback", "two_point_attempt",
        "two_point_conv_result", "extra_point_result", "first_down", "penalty", "ep", "epa", "wp", "wpa",
        "receive_2h_ko", "result", "pass_attempt", "rush_attempt", "fourth_down_converted",
        "fourth_down_failed", "punt_attempt", "field_goal_attempt", "home_timeouts_remaining",
        "away_timeouts_remaining", "total_home_score", "total_away_score"]
pbp = pd.concat([pd.read_csv(DATA / f"pbp_{y}.csv.gz", usecols=lambda c: c in cols, low_memory=False)
                 for y in (2023, 2024, 2025, 2026)], ignore_index=True)
reg = pbp[(pbp.season_type == "REG") & (pbp.season <= 2025)].copy()
print("  plays:", len(reg))

part = pd.concat([pd.read_csv(DATA / f"part_{y}.csv", usecols=["nflverse_game_id", "play_id", "defenders_in_box",
                                                              "number_of_pass_rushers", "defense_coverage_type",
                                                              "defense_man_zone_type"]) for y in (2023, 2024, 2025)])
part = part.rename(columns={"nflverse_game_id": "game_id"})
reg = reg.merge(part, on=["game_id", "play_id"], how="left")

reg["inc"] = reg.incomplete_pass.fillna(0)
reg["int_"] = reg.interception.fillna(0)
reg["fum"] = reg.fumble_lost.fillna(0)
reg["oob"] = reg.out_of_bounds.fillna(0)
reg["td"] = reg.touchdown.fillna(0)
reg["desc"] = reg["desc"].map(clean_desc)

# Defensive-call tags, from FTN charting via nflverse.
cov = reg.defense_coverage_type.fillna("")
late_lead = (reg.half_seconds_remaining <= 120) & (reg.qtr.isin([2, 4])) & (-reg.score_differential).between(4, 16)
reg["tag_blitz"] = reg.number_of_pass_rushers >= 5
reg["tag_cover2"] = cov.isin(["COVER_2", "2_MAN"])
reg["tag_prevent"] = late_lead & (reg.defense_man_zone_type == "ZONE_COVERAGE") & (reg.number_of_pass_rushers <= 4)
reg["tag_box"] = reg.defenders_in_box >= 8
reg["charted"] = reg.defense_coverage_type.notna() | reg.defenders_in_box.notna()

plays = reg[reg.play_type.isin(["run", "pass"]) & (reg.penalty.fillna(0) == 0) & (reg.two_point_attempt.fillna(0) == 0)]
runs = plays[(plays.play_type == "run") & (plays.qb_kneel.fillna(0) == 0) & (plays.qb_scramble.fillna(0) == 0)]
passes = plays[(plays.play_type == "pass") & (plays.sack.fillna(0) == 0) & (plays.qb_spike.fillna(0) == 0)
               & (plays.qb_scramble.fillna(0) == 0) & plays.air_yards.notna()]
dropbacks = plays[(plays.play_type == "pass") & (plays.qb_spike.fillna(0) == 0) & (plays.qb_scramble.fillna(0) == 0)]

cats = {
    "runIn": runs[(runs.run_location == "middle") | (runs.run_gap == "guard")],
    "runOut": runs[runs.run_location.isin(["left", "right"]) & (runs.run_gap == "end")],
    "quickOut": passes[passes.pass_location.isin(["left", "right"]) & passes.air_yards.between(-2, 9)],
    "slant": passes[(passes.pass_location == "middle") & passes.air_yards.between(0, 14)],
    "deep": passes[passes.air_yards >= 20],
    "hail": passes[(passes.air_yards >= 40) & (passes.half_seconds_remaining <= 20)],
}
TAGS = {"blitz": "tag_blitz", "cover2": "tag_cover2", "prevent": "tag_prevent", "box": "tag_box"}

bank, rates = {}, {}
for name, df in cats.items():
    entry = {"all": pack(sample(df, 600))}
    r = {"all": {"n": int(len(df)), "comp": rnd(df.complete_pass.mean()) if name not in ("runIn", "runOut") else None,
                 "ypp": rnd(df.yards_gained.mean(), 2), "epa": rnd(df.epa.mean())}}
    charted = df[df.charted]
    for tag, col in TAGS.items():
        sub = charted[charted[col].fillna(False)]
        if len(sub) >= 40 and name != "hail":
            entry[tag] = pack(sample(sub, 260))
            r[tag] = {"n": int(len(sub)), "comp": rnd(sub.complete_pass.mean()) if name not in ("runIn", "runOut") else None,
                      "ypp": rnd(sub.yards_gained.mean(), 2), "epa": rnd(sub.epa.mean())}
    bank[name] = entry
    rates[name] = r
    print(f"  {name:9s} n={len(df):6d}  " + "  ".join(f"{k}:{v['n']} epa={v['epa']}" for k, v in r.items()))

# Sacks: rate per dropback, overall and under each defensive tag.
sacks = dropbacks[dropbacks.sack.fillna(0) == 1].copy()
sacks["inc"] = 0
sack_rate = {"all": rnd(dropbacks.sack.mean())}
cd = dropbacks[dropbacks.charted]
for tag, col in TAGS.items():
    sub = cd[cd[col].fillna(False)]
    if len(sub) >= 40:
        sack_rate[tag] = rnd(sub.sack.mean())
sack_bank = pack(sample(sacks, 300))
print("  sack rate", sack_rate)

# Kicking and tries.
fg = reg[reg.field_goal_result.isin(["made", "missed", "blocked"])]
fgX = np.column_stack([np.ones(len(fg)), fg.kick_distance.values])
fg_beta = fit_logistic(fgX, (fg.field_goal_result == "made").astype(float).values)
xp = reg[reg.extra_point_result.isin(["good", "failed", "blocked"])]
two = reg[reg.two_point_conv_result.isin(["success", "failure"])]
punts = reg[(reg.play_type == "punt") & (reg.penalty.fillna(0) == 0) & reg.kick_distance.notna()].copy()
punts["net"] = np.where(punts.touchback == 1, punts.yardline_100 - 20, punts.kick_distance - punts.return_yards.fillna(0))
punt_net = sorted(int(x) for x in sample(punts, 300).net)

go4 = reg[(reg.down == 4) & reg.play_type.isin(["run", "pass"]) & (reg.penalty.fillna(0) == 0)
          & (reg.qb_kneel.fillna(0) == 0) & (reg.qb_spike.fillna(0) == 0)]
conv = {}
for d in range(1, 16):
    sub = go4[go4.ydstogo == d] if d < 15 else go4[go4.ydstogo >= 15]
    if len(sub) >= 15:
        conv[d] = rnd(((sub.fourth_down_converted.fillna(0) == 1) | (sub.touchdown.fillna(0) == 1)).mean())
gl = go4[(go4.ydstogo == 1) & (go4.yardline_100 == 1)]
# Touchdown rate on a 4th-down play by field position (5-yard buckets), so a final-play
# conversion can also be a touchdown.
td4 = []
for b in range(20):
    sub = go4[((go4.yardline_100 - 1) // 5) == b]
    td4.append(rnd(sub.touchdown.fillna(0).mean()) if len(sub) >= 15 else None)
kick = {
    "fg": [rnd(fg_beta[0], 4), rnd(fg_beta[1], 5)],
    "xp": rnd((xp.extra_point_result == "good").mean()),
    "two": rnd((two.two_point_conv_result == "success").mean()),
    "puntNet": punt_net,
    "conv4": conv,
    "td4": td4,
    "goalLine1": rnd(((gl.fourth_down_converted == 1) | (gl.touchdown == 1)).mean()),
    "n": {"fg": int(len(fg)), "xp": int(len(xp)), "two": int(len(two)), "punts": int(len(punts)), "go4": int(len(go4))},
}
print("  kick", {k: v for k, v in kick.items() if k != "puntNet"})


def ep_table(df, down_c, dist_c, yl_c, ep_c):
    t = df[[down_c, dist_c, yl_c, ep_c]].dropna()
    t = t[t[down_c].between(1, 4)]
    t["db"] = t[dist_c].map(bucket_dist)
    t["yb"] = ((t[yl_c].clip(1, 99) - 1) // 5).astype(int)
    g = t.groupby([down_c, "db", "yb"])[ep_c].agg(["mean", "count"])
    table = np.full((4, 8, 20), np.nan)
    for (d, db, yb), row in g.iterrows():
        if row["count"] >= 8:
            table[int(d) - 1, int(db), int(yb)] = row["mean"]
    # Fill gaps from the nearest filled cells along field position, then distance.
    for d in range(4):
        for db in range(8):
            row = table[d, db]
            idx = np.where(~np.isnan(row))[0]
            if len(idx):
                table[d, db] = np.interp(np.arange(20), idx, row[idx])
        for yb in range(20):
            col = table[d, :, yb]
            idx = np.where(~np.isnan(col))[0]
            if len(idx):
                table[d, :, yb] = np.interp(np.arange(8), idx, col[idx])
    return np.round(np.nan_to_num(table, nan=0.0), 2).tolist()


nfl_ep = ep_table(reg, "down", "ydstogo", "yardline_100", "ep")


def wp_features(diff, secs, ep, posTO, defTO, rec2h, qtr_first_half):
    t = np.asarray(secs, float) / 3600.0
    s = np.sqrt(np.asarray(secs, float) / 60.0 + 1.0)
    adj = (np.asarray(diff, float) + np.asarray(ep, float))
    return np.column_stack([
        np.ones_like(t), diff, adj / s, ep, t, (np.asarray(posTO) - np.asarray(defTO)) * (1 - t) ** 4,
        np.asarray(rec2h) * np.asarray(qtr_first_half), adj / (s ** 2), np.sign(adj) * (1 - t) ** 6,
    ])


def fit_wp(df, label):
    d = df.dropna(subset=["diff", "secs", "ep", "posTO", "defTO", "wp"])
    d = d[(d.secs > 0) & (d.secs <= 3600)]
    X = wp_features(d["diff"], d["secs"], d["ep"], d["posTO"], d["defTO"], d["rec2h"], d["fh"])
    beta = fit_logistic(X, d["wp"].clip(0.001, 0.999).values, iters=80)
    pred = 1 / (1 + np.exp(-np.clip(X @ beta, -30, 30)))
    mae = float(np.abs(pred - d["wp"].values).mean())
    late = d["secs"].values <= 300
    print(f"  {label} WP model: n={len(d)} MAE={mae:.3f} (last 5 min MAE={np.abs(pred - d['wp'].values)[late].mean():.3f})")
    return [rnd(b, 5) for b in beta], round(mae, 3)


TIME_EDGES = [15, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600]
DIFF_MAX = 24


def time_bucket(secs):
    for i, e in enumerate(TIME_EDGES):
        if secs <= e:
            return i
    return len(TIME_EDGES) - 1


def wp_table(df):
    """Mean nflverse/cfbfastR win probability by exact score margin, time left and field position.
    Unlike a smooth curve, this keeps the real cliffs (up 7 vs up 6, a field goal that ties)."""
    d = df.dropna(subset=["diff", "secs", "yl", "wp"])
    d = d[(d.secs > 0) & (d.secs <= 3600)]
    di = d["diff"].clip(-DIFF_MAX, DIFF_MAX).astype(int) + DIFF_MAX
    ti = d["secs"].map(time_bucket)
    fi = ((d["yl"].clip(1, 99) - 1) // 10).astype(int)
    g = pd.DataFrame({"di": di, "ti": ti, "fi": fi, "wp": d["wp"]}).groupby(["di", "ti", "fi"])["wp"].agg(["mean", "count"])
    table = [[[None] * 10 for _ in TIME_EDGES] for _ in range(2 * DIFF_MAX + 1)]
    for (a, b, c), row in g.iterrows():
        if row["count"] >= 12:
            table[a][b][c] = round(float(row["mean"]), 3)
    filled = sum(1 for a in table for b in a for c in b if c is not None)
    print(f"  WP table: {filled} of {len(table) * len(TIME_EDGES) * 10} cells from data")
    return table


wpdf = reg[reg.qtr <= 4].assign(diff=reg.score_differential, secs=reg.game_seconds_remaining, posTO=reg.posteam_timeouts_remaining,
                                defTO=reg.defteam_timeouts_remaining, rec2h=0.0, fh=(reg.qtr <= 2).astype(int))
nfl_wp, nfl_wp_mae = fit_wp(wpdf, "NFL")
nfl_wpt = wp_table(wpdf.assign(yl=wpdf.yardline_100))

# Team ratings: 2025 plus 2026-to-date (2026 counted double), EPA per play vs league average.
recent = pbp[(pbp.season_type == "REG") & (pbp.season >= 2025) & pbp.play_type.isin(["run", "pass"]) & pbp.epa.notna()].copy()
recent["w"] = np.where(recent.season == 2026, 2.0, 1.0)
lg_pass = np.average(recent[recent.play_type == "pass"].epa, weights=recent[recent.play_type == "pass"].w)
lg_run = np.average(recent[recent.play_type == "run"].epa, weights=recent[recent.play_type == "run"].w)
teams_csv = pd.read_csv(DATA / "teams.csv")
current = set(pbp[pbp.season == 2026].posteam.dropna())
teams = {}
for _, t in teams_csv[teams_csv.team_abbr.isin(current)].iterrows():
    a = t.team_abbr
    def avg(mask):
        x = recent[mask]
        return float(np.average(x.epa, weights=x.w)) if len(x) else 0.0
    teams[a] = {
        "name": t.team_name, "nick": t.team_nick, "color": t.team_color, "color2": t.team_color2,
        "offPass": rnd(avg((recent.posteam == a) & (recent.play_type == "pass")) - lg_pass),
        "offRun": rnd(avg((recent.posteam == a) & (recent.play_type == "run")) - lg_run),
        "defPass": rnd(avg((recent.defteam == a) & (recent.play_type == "pass")) - lg_pass),
        "defRun": rnd(avg((recent.defteam == a) & (recent.play_type == "run")) - lg_run),
    }
print("  teams:", len(teams))

nfl = {"bank": bank, "rates": rates, "sackRate": sack_rate, "sacks": sack_bank, "kick": kick, "ep": nfl_ep,
       "wp": nfl_wp, "wpMAE": nfl_wp_mae, "wpTable": nfl_wpt, "timeEdges": TIME_EDGES, "diffMax": DIFF_MAX, "teams": teams,
       "epaVar": rnd(plays.epa.var(), 3),
       "meta": {"seasons": "2023–2025 regular seasons", "charting": "FTN Data via nflverse (2023–2025)",
                "plays": int(len(plays)), "ratings": "2025 season + 2026 through Week 5"}}

# ---------------------------------------------------------------- college

print("College: loading play-by-play…")
ccols = ["game_id", "week", "season", "home", "away", "pos_team", "def_pos_team", "period", "clock_minutes",
         "clock_seconds", "TimeSecsRem", "down", "distance", "yards_to_goal", "play_type", "play_text",
         "yards_gained", "EPA", "ep_before", "wp_before", "wpa", "pos_team_score", "def_pos_team_score",
         "pos_team_timeouts_rem_before", "def_pos_team_timeouts_rem_before", "pos_team_receives_2H_kickoff",
         "completion", "pass_attempt", "rush", "sack", "int", "fumble_vec", "touchdown", "penalty_flag",
         "firstD_by_yards", "firstD_by_poss", "yds_punted", "yds_punt_return", "punt_tb", "fg_kick_distance",
         "fg_made", "pass", "season_type", "kneel_down", "sack_vec", "turnover", "home_team_division", "away_team_division"]
cfb = pd.concat([pd.read_parquet(DATA / f"cfb_{y}.parquet", columns=None).pipe(lambda d: d[[c for c in ccols if c in d.columns]])
                 for y in (2024, 2025, 2026)], ignore_index=True)
creg = cfb[cfb.season <= 2025].copy()
creg["desc"] = creg.play_text.fillna("").str.slice(0, 140)
creg["epa"] = creg.EPA
creg["oob"] = creg.play_text.fillna("").str.contains("out of bounds", case=False).astype(int)
creg["td"] = creg.touchdown.fillna(0)
creg["fum"] = creg.play_type.isin(["Fumble Recovery (Opponent)", "Fumble Recovery (Opponent) Touchdown"]).astype(int)
creg["int_"] = creg.play_type.isin(["Interception Return", "Interception Return Touchdown", "Interception"]).astype(int)
creg["inc"] = (creg.play_type == "Pass Incompletion").astype(int)
crun = creg[creg.play_type.isin(["Rush", "Rushing Touchdown"]) & ~creg.play_text.fillna("").str.contains("kneel", case=False)]
cpass = creg[creg.play_type.isin(["Pass Reception", "Passing Touchdown", "Pass Incompletion", "Interception Return",
                                  "Interception Return Touchdown"])]
c_sack = creg[creg.play_type == "Sack"].copy()
c_sack["inc"] = 0
# College data has no air yards or pass location; split passes by gain to approximate route depth.
ccomp = cpass[cpass.inc == 0]
short = pd.concat([ccomp[ccomp.yards_gained < 15], cpass[cpass.inc == 1].sample(frac=0.75, random_state=3)])
deep = pd.concat([ccomp[ccomp.yards_gained >= 20], cpass[cpass.inc == 1].sample(frac=0.25, random_state=4)])
cbank = {
    "runIn": {"all": pack(sample(crun, 600))},
    "runOut": {"all": pack(sample(crun[crun.yards_gained.abs() < 60], 600))},
    "quickOut": {"all": pack(sample(short, 600))},
    "slant": {"all": pack(sample(short, 600))},
    "deep": {"all": pack(sample(deep, 600))},
}
c_rates = {k: {"all": {"n": int(len(v)), "epa": rnd(v.epa.mean())}} for k, v in
           {"run": crun, "pass": cpass, "short": short, "deep": deep}.items()}
c_sack_rate = {"all": rnd(len(c_sack) / (len(cpass) + len(c_sack)))}
cfg = creg[creg.play_type.isin(["Field Goal Good", "Field Goal Missed", "Blocked Field Goal"])].copy()
cfg["dist"] = cfg.yards_to_goal + 17
cfg_beta = fit_logistic(np.column_stack([np.ones(len(cfg)), cfg.dist.values]), (cfg.play_type == "Field Goal Good").astype(float).values)
cpunt = creg[creg.play_type.isin(["Punt", "Punt Return"]) & creg.yds_punted.notna()]
cpunt_net = sorted(int(x) for x in sample(cpunt.assign(net=cpunt.yds_punted - cpunt.yds_punt_return.fillna(0)), 300).net)
cgo = creg[(creg.down == 4) & creg.play_type.isin(["Rush", "Pass Reception", "Pass Incompletion", "Rushing Touchdown",
                                                    "Passing Touchdown", "Sack", "Interception Return"])]
cconv = {}
for d in range(1, 16):
    sub = cgo[cgo.distance == d] if d < 15 else cgo[cgo.distance >= 15]
    sub = sub[sub.home_team_division.eq("fbs") & sub.away_team_division.eq("fbs")] if "home_team_division" in sub else sub
    if len(sub) >= 15:
        cconv[d] = rnd((sub.yards_gained >= sub.distance).mean())
ctd4 = []
for b in range(20):
    sub = cgo[((cgo.yards_to_goal - 1) // 5) == b]
    ctd4.append(rnd((sub.touchdown.fillna(0) == 1).mean()) if len(sub) >= 15 else None)
ckick = {"td4": ctd4, "fg": [rnd(cfg_beta[0], 4), rnd(cfg_beta[1], 5)], "xp": 0.98, "two": None, "puntNet": cpunt_net, "conv4": cconv,
         "n": {"fg": int(len(cfg)), "go4": int(len(cgo))}}
c_ep = ep_table(creg, "down", "distance", "yards_to_goal", "ep_before")
creg["secs"] = np.where(creg.period <= 2, creg.TimeSecsRem.fillna(0) + 1800, creg.TimeSecsRem.fillna(0))
cwp = creg[creg.period <= 4].assign(diff=creg.pos_team_score - creg.def_pos_team_score, ep=creg.ep_before,
                                    posTO=creg.pos_team_timeouts_rem_before, defTO=creg.def_pos_team_timeouts_rem_before,
                                    rec2h=0.0,
                                    fh=(creg.period <= 2).astype(int), wp=creg.wp_before)
cfb_wp, cfb_wp_mae = fit_wp(cwp, "College")
cfb_wpt = wp_table(cwp.assign(yl=cwp.yards_to_goal))
cfbd = {"bank": cbank, "rates": c_rates, "sackRate": c_sack_rate, "sacks": pack(sample(c_sack, 300)), "kick": ckick,
        "ep": c_ep, "wp": cfb_wp, "wpMAE": cfb_wp_mae, "wpTable": cfb_wpt, "timeEdges": TIME_EDGES, "diffMax": DIFF_MAX, "epaVar": rnd(pd.concat([crun, cpass]).epa.var(), 3),
        "meta": {"seasons": "2024–2025 FBS seasons (cfbfastR)", "plays": int(len(crun) + len(cpass)),
                 "note": "College data has no air yards or pass location, so short and deep passes are split by yards gained."}}
print("  college kick", {k: v for k, v in ckick.items() if k != "puntNet"})

# ---------------------------------------------------------------- decision model (mirrors js/model.js)


class Model:
    def __init__(self, d):
        self.ep = np.array(d["ep"]); self.wp = np.array(d["wp"]); self.k = d["kick"]; self.t = d["wpTable"]

    def eff_yl(self, down, dist, yl):
        """Field position on 1st & 10 worth the same expected points as (down, dist, yl)."""
        target = self.ep_at(down, dist, yl)
        if down == 1 and dist >= 10:
            return yl
        row = self.ep[0, bucket_dist(10)]
        best = min(range(20), key=lambda i: abs(row[i] - target))
        return best * 5 + 3

    def ep_at(self, down, dist, yl):
        return float(self.ep[int(min(4, max(1, down))) - 1, bucket_dist(dist), int((min(99, max(1, yl)) - 1) // 5)])

    def wp_at(self, diff, secs, down, dist, yl, posTO, defTO):
        if secs <= 1:
            return 1.0 if diff > 0 else 0.0 if diff < 0 else 0.5
        if (secs <= 8 and yl >= 60) or (secs <= 20 and yl >= 50):  # little time to score from your own end
            return 0.97 if diff > 0 else 0.03 if diff < 0 else 0.52
        smooth = self.wp_smooth(diff, secs, down, dist, yl, posTO, defTO)
        # Blend toward the real-data table in the last 15 minutes, where exact margins matter.
        w = 1.0 if secs <= 300 else 0.0 if secs >= 900 else (900 - secs) / 600
        if w == 0:
            return smooth
        tab = self.wp_tab(diff, secs, down, dist, yl, posTO, defTO)
        return smooth if tab is None else w * tab + (1 - w) * smooth

    def wp_tab(self, diff, secs, down, dist, yl, posTO, defTO):
        cell = self.t[int(max(-DIFF_MAX, min(DIFF_MAX, diff))) + DIFF_MAX][time_bucket(secs)][int((min(99, max(1, self.eff_yl(down, dist, yl))) - 1) // 10)]
        if cell is not None:
            t = secs / 3600
            z = math.log(max(1e-4, min(1 - 1e-4, cell)) / (1 - max(1e-4, min(1 - 1e-4, cell)))) + self.wp[5] * (posTO - defTO) * (1 - t) ** 4
            return 1 / (1 + math.exp(-z))
        return None

    def wp_smooth(self, diff, secs, down, dist, yl, posTO, defTO):
        ep = self.ep_at(down, dist, yl)
        X = wp_features(np.array([diff]), np.array([max(1, secs)]), np.array([ep]), np.array([posTO]), np.array([defTO]),
                        np.array([0]), np.array([0]))
        z = float((X @ self.wp)[0])
        return 1 / (1 + math.exp(-max(-30, min(30, z))))

    def opp(self, diff, secs, yl, posTO, defTO):
        """Our WP when the opponent gets 1st & 10 at their yardline_100 = yl."""
        return 1 - self.wp_at(-diff, secs, 1, 10, yl, defTO, posTO)

    def fg_p(self, dist):
        a, b = self.k["fg"]
        return 1 / (1 + math.exp(-(a + b * dist)))

    def conv_p(self, dist):
        c = self.k["conv4"]
        keys = sorted(int(k) for k in c)
        k = min(keys, key=lambda x: abs(x - min(dist, 15)))
        return c[k] if k in c else c[str(k)]

    def fourth(self, diff, secs, dist, yl, posTO, defTO):
        s2 = max(1, secs - 6)
        out = {}
        p = self.conv_p(dist)
        td_win = self.opp(diff + 7, s2, 75, posTO, defTO)
        if dist >= yl:  # goal to go: converting is a touchdown
            win = td_win
        else:
            td = self.k["td4"][int((min(99, max(1, yl)) - 1) // 5)] or 0
            ptd = min(p, td)
            first = self.wp_at(diff, s2, 1, 10, yl - dist, posTO, defTO)
            win = (ptd * td_win + (p - ptd) * first) / p if p > 0 else first
        lose = self.opp(diff, s2, 100 - yl, posTO, defTO)
        out["go"] = p * win + (1 - p) * lose
        if yl >= 30:
            net = float(np.mean(self.k["puntNet"]))
            land = yl - net
            out["punt"] = self.opp(diff, max(1, secs - 8), 80 if land <= 0 else 100 - land, posTO, defTO)
        if yl + 17 <= 62:
            pf = self.fg_p(yl + 17)
            make = self.opp(diff + 3, s2, 75, posTO, defTO)
            miss_spot = yl + 7
            miss = self.opp(diff, s2, 80 if miss_spot <= 20 else 100 - miss_spot, posTO, defTO)
            out["fg"] = pf * make + (1 - pf) * miss
        return {k: round(v, 4) for k, v in out.items()}, p

    def tries(self, diff_after_td, secs, posTO, defTO, two=0.48, xp=0.94):
        kick = xp * self.opp(diff_after_td + 1, secs, 75, posTO, defTO) + (1 - xp) * self.opp(diff_after_td, secs, 75, posTO, defTO)
        go = two * self.opp(diff_after_td + 2, secs, 75, posTO, defTO) + (1 - two) * self.opp(diff_after_td, secs, 75, posTO, defTO)
        return {"pat": round(kick, 4), "two": round(go, 4)}


nm, cm = Model(nfl), Model(cfbd)
print("  sanity: tied, 4th & 1 at opp 45, 2nd qtr ->", nm.fourth(0, 1800 + 390, 1, 45, 3, 3))
print("  sanity: up 10, 4th & goal at 2, 7:30 left ->", nm.fourth(10, 450, 2, 2, 2, 2))
print("  sanity: down 5, 4th & 8 own 33, 6:50 ->", nm.fourth(-5, 410, 8, 67, 3, 3))
print("  sanity: down 3, 4th & 1 at opp 36, 0:21 ->", nm.fourth(-3, 21, 1, 36, 0, 1))
print("  sanity: up 3, 4th & 1 own 43, 1:46, opp 0 TO ->", nm.fourth(3, 106, 1, 57, 1, 0))
print("  sanity: tied, 4th & 4 at opp 30, 2:10 ->", nm.fourth(0, 130, 4, 30, 2, 2))
print("  sanity tries: down 2 after TD 3:00", nm.tries(-2, 180, 2, 2), " up 5", nm.tries(5, 200, 2, 2), " up 6", nm.tries(6, 200, 2, 2), " up 1", nm.tries(1, 400, 2, 2))

# ---------------------------------------------------------------- 2026 moments

def mmss(secs_in_q):
    secs_in_q = int(max(0, secs_in_q))
    return f"{secs_in_q // 60}:{secs_in_q % 60:02d}"


LABEL = {"go": "Go for it", "punt": "Punt", "fg": "Kick the field goal", "pat": "Kick the PAT", "two": "Go for two"}


def grade_options(vals):
    best = max(vals.values())
    return {k: ("best" if v >= best - 0.005 else "ok" if v >= best - 0.02 else "bad") for k, v in vals.items()}


def moment_from(row, kind, vals, real_key, league, teams_map, extra):
    grades = grade_options(vals)
    opts = []
    for k, v in sorted(vals.items(), key=lambda kv: -kv[1]):
        opts.append({"key": k, "text": LABEL[k], "grade": grades[k], "wp": round(v, 3), "real": k == real_key})
    return {**extra, "kind": kind, "league": league, "options": opts}


nfl26 = pbp[(pbp.season == 2026)].copy()
nfl26["desc_full"] = nfl26["desc"]
nfl26["desc"] = nfl26["desc"].map(clean_desc)


def secs_q(row):
    m, s = str(row.time).split(":") if isinstance(row.time, str) and ":" in str(row.time) else (0, 0)
    return int(m) * 60 + int(s)


def nfl_real_key(r):
    if r.play_type == "punt":
        return "punt"
    if r.play_type == "field_goal":
        return "fg"
    if r.play_type in ("run", "pass"):
        return "go"
    return None


def nfl_outcome(r):
    return f"{r.desc} (EPA {r.epa:+.2f}, win probability {r.wpa * 100:+.1f} pts)"


auto = []
fourth = nfl26[(nfl26.down == 4) & nfl26.play_type.isin(["run", "pass", "punt", "field_goal"]) & (nfl26.penalty.fillna(0) == 0)
               & (nfl26.qtr <= 4) & nfl26.wp.between(0.05, 0.95) & (nfl26.qb_kneel.fillna(0) == 0)]
for r in fourth.itertuples():
    real = nfl_real_key(r)
    if real is None:
        continue
    vals, p = nm.fourth(r.score_differential, r.game_seconds_remaining, r.ydstogo, r.yardline_100,
                        r.posteam_timeouts_remaining, r.defteam_timeouts_remaining)
    if real not in vals or len(vals) < 2:
        continue
    spread = max(vals.values()) - min(vals.values())
    gap = max(vals.values()) - vals[real]
    auto.append((spread + gap, "nfl", r, vals, real, p))

tries = nfl26[(nfl26.qtr == 4) & ((nfl26.two_point_attempt == 1) | nfl26.extra_point_result.notna())]
for r in tries.iloc[0:0].itertuples():  # disabled: try decisions graded by the chart instead
    diff_after = r.score_differential  # posteam diff before the try
    real = "two" if r.two_point_attempt == 1 else "pat"
    vals = nm.tries(diff_after, r.game_seconds_remaining, r.posteam_timeouts_remaining, r.defteam_timeouts_remaining,
                    two=kick["two"], xp=kick["xp"])
    if abs(vals["two"] - vals["pat"]) < 0.01:
        continue
    auto.append((abs(vals["two"] - vals["pat"]) * 2, "nfl-try", r, vals, real, None))

auto.sort(key=lambda x: -x[0])
moments = []
seen = set()
for lev, kind, r, vals, real, p in auto:
    key = (r.game_id, r.qtr, r.time)
    if key in seen:
        continue
    seen.add(key)
    pos, dfn = r.posteam, r.defteam
    gtg = r.ydstogo >= r.yardline_100
    sit = {"quarter": int(r.qtr), "clock": str(r.time), "score": {"us": int(r.posteam_score), "them": int(r.defteam_score)},
           "teams": {"us": pos, "them": dfn}, "possession": "us",
           "timeouts": {"us": int(r.posteam_timeouts_remaining), "them": int(r.defteam_timeouts_remaining)}}
    if kind == "nfl":
        sit.update({"down": 4, "distance": int(r.ydstogo), "yardLine": int(100 - r.yardline_100), "goalToGo": bool(gtg)})
        title = f"4th & {'goal' if gtg else int(r.ydstogo)} at the {('opponent ' + str(int(r.yardline_100))) if r.yardline_100 < 50 else ('own ' + str(int(100 - r.yardline_100))) if r.yardline_100 > 50 else '50'}"
        prompt = f"You're {teams.get(pos, {}).get('nick', pos)}. {('Up ' + str(int(r.score_differential))) if r.score_differential > 0 else ('Down ' + str(int(-r.score_differential))) if r.score_differential < 0 else 'Tied'}, Q{int(r.qtr)} {re.sub(r'^0(?=\d:)', '', str(r.time))}. 4th & {'goal' if gtg else int(r.ydstogo)}."
        cat = "fourth"
        conv_note = f"League-wide, 4th & {min(int(r.ydstogo), 15)}{'+' if r.ydstogo >= 15 else ''} converts {p * 100:.0f}% of the time (2023–25)."
    else:
        sit.update({"down": 0, "distance": 0, "yardLine": 98, "pat": True})
        d = int(r.score_differential)
        title = f"{'Up' if d > 0 else 'Down' if d < 0 else 'Tied'} {abs(d) if d else ''} after the TD".replace("  ", " ")
        prompt = f"You're {teams.get(pos, {}).get('nick', pos)}. You just scored. {('Up ' + str(d)) if d > 0 else ('Down ' + str(-d)) if d < 0 else 'Tied'} before the try, Q4 {r.time}."
        cat = "twopt"
        conv_note = f"League-wide: PAT {kick['xp'] * 100:.0f}%, two-point try {kick['two'] * 100:.0f}% (2023–25)."
    m = moment_from(r, kind, vals, real, "nfl", teams, {
        "id": f"auto-{r.game_id}-{int(r.play_id)}", "category": cat, "title": title, "prompt": prompt, "situation": sit,
        "game": f"{r.away_team} at {r.home_team} · Week {int(r.week)}, 2026",
        "realResult": nfl_outcome(r), "wpBefore": rnd(r.wp), "convNote": conv_note,
    })
    moments.append(m)
    if len(moments) >= 40:
        break
print("  auto NFL moments:", len(moments))

# College 2026 moments
c26 = cfb[cfb.season == 2026].copy()
c26["secs"] = np.where(c26.period <= 2, c26.TimeSecsRem.fillna(0) + 1800, c26.TimeSecsRem.fillna(0))
c26_fbs = c26[c26.home_team_division.eq("fbs") & c26.away_team_division.eq("fbs")] if "home_team_division" in c26 else c26
c4 = c26_fbs[(c26_fbs.down == 4) & (c26.period <= 4) & c26.wp_before.between(0.05, 0.95)
         & c26.play_type.isin(["Rush", "Pass Reception", "Pass Incompletion", "Punt", "Punt Return", "Field Goal Good",
                               "Field Goal Missed", "Rushing Touchdown", "Passing Touchdown", "Sack", "Interception Return"])]
cauto = []
for r in c4.itertuples():
    real = "punt" if r.play_type.startswith("Punt") else "fg" if r.play_type.startswith("Field Goal") else "go"
    diff = r.pos_team_score - r.def_pos_team_score
    vals, p = cm.fourth(diff, r.secs, r.distance, r.yards_to_goal, r.pos_team_timeouts_rem_before or 0, r.def_pos_team_timeouts_rem_before or 0)
    if real not in vals or len(vals) < 2:
        continue
    lev = max(vals.values()) - min(vals.values()) + max(vals.values()) - vals[real]
    cauto.append((lev, r, vals, real, p, diff))
cauto.sort(key=lambda x: -x[0])
short_name = lambda n: (n or "")[:10]
for lev, r, vals, real, p, diff in cauto[:30]:
    gtg = r.distance >= r.yards_to_goal
    sit = {"quarter": int(r.period), "clock": f"{int(r.clock_minutes)}:{int(r.clock_seconds):02d}",
           "score": {"us": int(r.pos_team_score), "them": int(r.def_pos_team_score)},
           "teams": {"us": short_name(r.pos_team), "them": short_name(r.def_pos_team)}, "possession": "us",
           "timeouts": {"us": int(r.pos_team_timeouts_rem_before or 0), "them": int(r.def_pos_team_timeouts_rem_before or 0)},
           "down": 4, "distance": int(r.distance), "yardLine": int(100 - r.yards_to_goal), "goalToGo": bool(gtg)}
    ylt = int(r.yards_to_goal)
    m = moment_from(r, "cfb", vals, real, "cfb", {}, {
        "id": f"auto-cfb-{r.game_id}-{r.period}-{r.clock_minutes}-{r.clock_seconds}", "category": "fourth",
        "title": f"4th & {'goal' if gtg else int(r.distance)} at the {('opponent ' + str(ylt)) if ylt < 50 else ('own ' + str(100 - ylt)) if ylt > 50 else '50'}",
        "prompt": f"You're {r.pos_team}. {('Up ' + str(int(diff))) if diff > 0 else ('Down ' + str(int(-diff))) if diff < 0 else 'Tied'}, Q{int(r.period)} {int(r.clock_minutes)}:{int(r.clock_seconds):02d}. 4th & {'goal' if gtg else int(r.distance)}.",
        "situation": sit, "game": f"{r.away} at {r.home} · Week {int(r.week)}, 2026",
        "realResult": f"{(r.play_text or '')[:140]} (EPA {r.EPA:+.2f}, win probability {r.wpa * 100:+.1f} pts)",
        "wpBefore": rnd(r.wp_before), "convNote": f"In college, 4th & {min(int(r.distance), 15)}{'+' if r.distance >= 15 else ''} converts {p * 100:.0f}% of the time (2024–25).",
    })
    moments.append(m)
print("  auto total:", len(moments))

# ---------------------------------------------------------------- facts for the hand-picked Real Moments


def nfl_find(week, team, **conds):
    g = nfl26[(nfl26.week == week) & ((nfl26.home_team == team) | (nfl26.away_team == team))]
    for k, v in conds.items():
        g = g[g[k] == v] if not callable(v) else g[v(g)]
    return g


facts = {}


def nfl_fact(key, row, vals=None, real=None):
    r = row.iloc[0]
    f = {"clock": str(r.time), "quarter": int(r.qtr), "timeouts": {"us": int(r.posteam_timeouts_remaining), "them": int(r.defteam_timeouts_remaining)},
         "score": {"us": int(r.posteam_score), "them": int(r.defteam_score)}, "teams": {"us": r.posteam, "them": r.defteam},
         "down": int(r.down) if not pd.isna(r.down) else None, "distance": int(r.ydstogo) if not pd.isna(r.ydstogo) else None,
         "yardLine": int(100 - r.yardline_100) if not pd.isna(r.yardline_100) else None,
         "wp": rnd(r.wp), "wpa": rnd(r.wpa), "epa": rnd(r.epa, 2), "desc": r.desc}
    if r.down == 4:
        v, p = nm.fourth(r.score_differential, r.game_seconds_remaining, r.ydstogo, r.yardline_100,
                         r.posteam_timeouts_remaining, r.defteam_timeouts_remaining)
        f["model"] = v
        f["conv"] = p
    facts[key] = f
    print(f"  fact {key}: Q{f['quarter']} {f['clock']} {f['teams']} {f['score']} TO{f['timeouts']} wp={f['wp']} wpa={f['wpa']} epa={f['epa']} :: {f['desc'][:90]}")


try:
    nfl_fact("real-bears-sneak", nfl_find(1, "CHI", posteam="CHI", down=4, ydstogo=1, yardline_100=79))
except Exception as e:
    print("  bears not found", e)
try:
    nfl_fact("real-jets-fourth", nfl_find(2, "NYJ", posteam="NYJ", down=4, ydstogo=1, yardline_100=50, qtr=4))
except Exception as e:
    print("  jets 4th not found", e)
try:
    ot = nfl_find(2, "NYJ", qtr=5)
    ot = ot[ot.posteam.notna()]
    nfl_fact("real-jets-ot", ot.head(1))
except Exception as e:
    print("  jets ot not found", e)
try:
    nfl_fact("real-eagles-goal", nfl_find(4, "PHI", posteam="PHI", down=4, yardline_100=2, qtr=4))
except Exception as e:
    print("  eagles not found", e)
try:
    g = nfl_find(5, "NYG", qtr=5, posteam="NYG")
    nfl_fact("real-giants-ot", g[g.fumble_lost == 1].head(1))
except Exception as e:
    print("  giants not found", e)
try:
    g = nfl_find(5, "WAS", qtr=5, posteam="WAS")
    g = g[g.play_type.isin(["run", "pass", "qb_spike"])]
    nfl_fact("real-commanders-ot", g.tail(1))
except Exception as e:
    print("  commanders not found", e)


def cfb_find(team, week):
    return c26[((c26.home == team) | (c26.away == team)) & (c26.week == week)]


def cfb_fact(key, df):
    r = df.iloc[0]
    diff = r.pos_team_score - r.def_pos_team_score
    f = {"clock": f"{int(r.clock_minutes)}:{int(r.clock_seconds):02d}", "quarter": int(r.period),
         "timeouts": {"us": int(r.pos_team_timeouts_rem_before or 0), "them": int(r.def_pos_team_timeouts_rem_before or 0)},
         "score": {"us": int(r.pos_team_score), "them": int(r.def_pos_team_score)}, "teams": {"us": r.pos_team, "them": r.def_pos_team},
         "down": int(r.down) if not pd.isna(r.down) else None, "distance": int(r.distance) if not pd.isna(r.distance) else None,
         "yardLine": int(100 - r.yards_to_goal) if not pd.isna(r.yards_to_goal) else None,
         "wp": rnd(r.wp_before), "wpa": rnd(r.wpa), "epa": rnd(r.EPA, 2), "desc": str(r.play_text)[:160]}
    if r.down == 4:
        v, p = cm.fourth(diff, r.secs, r.distance, r.yards_to_goal, r.pos_team_timeouts_rem_before or 0, r.def_pos_team_timeouts_rem_before or 0)
        f["model"], f["conv"] = v, p
    facts[key] = f
    print(f"  fact {key}: Q{f['quarter']} {f['clock']} {f['teams']} {f['score']} TO{f['timeouts']} wp={f['wp']} wpa={f['wpa']} :: {f['desc'][:90]}")


try:
    g = cfb_find("Ohio State", 2)
    g = g[(g.pos_team == "Texas") & (g.period == 4) & (g.yards_to_goal == 1) & (g.down == 1)]
    cfb_fact("real-osu-goal-line", g.head(1))
except Exception as e:
    print("  osu not found", e)
try:
    g = cfb_find("Oregon", 2)
    cfb_fact("real-oregon-fourth", g[(g.pos_team == "Oregon") & (g.period == 4) & (g.down == 4) & (g.distance == 8)].head(1))
except Exception as e:
    print("  oregon not found", e)
try:
    g = cfb_find("LSU", 6)
    cfb_fact("real-lsu-punt", g[(g.pos_team == "LSU") & (g.period == 4) & (g.down == 4) & (g.distance == 1)].tail(1))
except Exception as e:
    print("  lsu not found", e)
try:
    g = cfb_find("LSU", 6)
    g = g[(g.period >= 5) & (g.pos_team == "Kentucky")]
    cfb_fact("real-kentucky-two", g.tail(1))
except Exception as e:
    print("  kentucky not found", e)

# ---------------------------------------------------------------- play durations
# Snap-to-whistle time, measured where the clock was stopped before the snap and stopped
# again after the play (incompletions, out of bounds and plays followed by a timeout in the
# last two minutes of a half), so the clock difference is the play itself.
allp = pbp[pbp.season <= 2025].sort_values(["game_id", "play_id"]).copy()
allp["next_gsr"] = allp.groupby("game_id").game_seconds_remaining.shift(-1)
allp["prev_stop"] = allp.groupby("game_id").apply(
    lambda g: ((g.incomplete_pass == 1) | (g.out_of_bounds == 1) | (g.play_type.isin(["no_play"])) | g.desc.str.contains("Timeout", na=False)).shift(1),
    include_groups=False).reset_index(level=0, drop=True).fillna(False)
stop_after = (allp.incomplete_pass == 1) | (allp.out_of_bounds == 1)
win = allp[(allp.half_seconds_remaining <= 120) & allp.prev_stop & stop_after & allp.play_type.isin(["run", "pass"])].copy()
win["dur"] = allp.loc[win.index, "game_seconds_remaining"] - win["next_gsr"]
win = win[win.dur.between(1, 15)]
def dur_list(mask):
    x = win[mask].dur.astype(int)
    return sorted(int(v) for v in (x.sample(min(len(x), 200), random_state=1) if len(x) else []))
durations = {
    "run": dur_list(win.play_type == "run"),
    "shortPass": dur_list((win.play_type == "pass") & (win.air_yards.fillna(0) < 15) & (win.complete_pass == 1)),
    "deepPass": dur_list((win.play_type == "pass") & (win.air_yards.fillna(0) >= 15) & (win.complete_pass == 1)),
    "incomplete": dur_list((win.play_type == "pass") & (win.incomplete_pass == 1)),
}
print("  durations (median s):", {k: (v[len(v) // 2] if v else None, len(v)) for k, v in durations.items()})
nfl["durations"] = durations

# ---------------------------------------------------------------- 2026 schedule (season mode)
games = pd.read_csv(DATA / "games.csv")
g26 = games[(games.season == 2026) & (games.game_type == "REG")]
schedule = {}
for t in teams:
    rows = g26[(g26.home_team == t) | (g26.away_team == t)].sort_values("week")
    schedule[t] = [{"week": int(r.week), "opp": r.away_team if r.home_team == t else r.home_team, "home": bool(r.home_team == t),
                    "date": str(r.gameday), "espn": None if pd.isna(r.espn) else str(int(r.espn)),
                    "real": None if pd.isna(r.home_score) else {"us": int(r.home_score if r.home_team == t else r.away_score),
                                                               "them": int(r.away_score if r.home_team == t else r.home_score)}}
                   for r in rows.itertuples()]
nfl["schedule"] = schedule
print("  schedule teams:", len(schedule), "games for KC:", len(schedule.get("KC", [])))

# ---------------------------------------------------------------- replay games (companion)
TYPE = {"run": "run", "pass": "pass", "punt": "punt", "field_goal": "fg", "kickoff": "kickoff", "extra_point": "xp",
        "qb_kneel": "kneel", "qb_spike": "spike", "no_play": "other"}


def nfl_replay(game_id, title):
    g = nfl26[nfl26.game_id == game_id].sort_values("play_id")
    rows = []
    for r in g.itertuples():
        if pd.isna(r.qtr) or (pd.isna(r.posteam) and "Timeout" not in str(r.desc_full)):
            continue
        home = r.posteam == r.home_team
        typ = "timeout" if "Timeout #" in str(r.desc_full) else ("2pt" if r.two_point_attempt == 1 else TYPE.get(r.play_type, "other"))
        hs = int(r.posteam_score if home else r.defteam_score) if not pd.isna(r.posteam_score) else None
        as_ = int(r.defteam_score if home else r.posteam_score) if not pd.isna(r.posteam_score) else None
        rows.append([int(r.qtr), str(r.time), None if pd.isna(r.down) else int(r.down), None if pd.isna(r.ydstogo) else int(r.ydstogo),
                     None if pd.isna(r.yardline_100) else int(r.yardline_100), "H" if home else "A", hs, as_,
                     None if pd.isna(r.home_timeouts_remaining) else int(r.home_timeouts_remaining),
                     None if pd.isna(r.away_timeouts_remaining) else int(r.away_timeouts_remaining), typ, r.desc,
                     None if pd.isna(r.wp) else round(float(r.wp if home else 1 - r.wp), 3)])
    first = g.iloc[0]
    final = g.iloc[-1]
    return {"id": game_id, "league": "nfl", "title": title, "home": first.home_team, "away": first.away_team,
            "week": int(first.week), "final": f"{first.away_team} {int(final.total_away_score)}, {first.home_team} {int(final.total_home_score)}",
            "plays": rows}


CFB_TYPE = lambda t: ("punt" if str(t).startswith("Punt") else "fg" if "Field Goal" in str(t) else "kickoff" if "Kickoff" in str(t)
                      else "timeout" if t == "Timeout" else "run" if str(t).startswith("Rush") else
                      "pass" if str(t).startswith("Pass") or str(t) in ("Sack", "Interception Return") else "other")


def cfb_replay(team, week, title):
    g = c26[((c26.home == team) | (c26.away == team)) & (c26.week == week)]
    rows = []
    for r in g.itertuples():
        home = r.pos_team == r.home
        rows.append([int(r.period), f"{int(r.clock_minutes)}:{int(r.clock_seconds):02d}", None if pd.isna(r.down) or r.down < 1 else int(r.down),
                     None if pd.isna(r.distance) else int(r.distance), None if pd.isna(r.yards_to_goal) else int(r.yards_to_goal),
                     "H" if home else "A", int(r.pos_team_score if home else r.def_pos_team_score), int(r.def_pos_team_score if home else r.pos_team_score),
                     None, None, CFB_TYPE(r.play_type), str(r.play_text)[:140],
                     None if pd.isna(r.wp_before) else round(float(r.wp_before if home else 1 - r.wp_before), 3)])
    first = g.iloc[0]
    last = rows[-1]
    return {"id": f"cfb-{team}-{week}", "league": "cfb", "title": title, "home": first.home[:10], "away": first.away[:10],
            "week": int(week), "final": f"{first.away} {last[7]}, {first.home} {last[6]}", "plays": rows}


def gid(week, team):
    g = nfl26[(nfl26.week == week) & ((nfl26.home_team == team) | (nfl26.away_team == team))]
    return g.game_id.iloc[0]


replays = [
    nfl_replay(gid(2, "NYJ"), "Packers at Jets: the 4th & 1 and overtime"),
    nfl_replay(gid(4, "PHI"), "Rams at Eagles: the 4th & goal and the comeback"),
    nfl_replay(gid(5, "WAS"), "Giants at Commanders: the overtime tie"),
    nfl_replay(gid(3, "IND"), "Texans at Colts: the late field goal"),
    nfl_replay(gid(1, "CHI"), "Bears at Panthers: the 59-point shootout"),
    cfb_replay("Texas", 2, "Ohio State at Texas: the goal-line stand"),
    cfb_replay("Kentucky", 6, "LSU at Kentucky: the punt and the OT two-pointer"),
]
print("  replays:", [(r["title"][:25], len(r["plays"])) for r in replays])

# ---------------------------------------------------------------- write


def write(name, var, obj):
    txt = f"// Generated by scripts/build_data.py — do not edit by hand.\nconst {var} = {json.dumps(obj, separators=(',', ':'), ensure_ascii=False)};\n"
    (OUT / name).write_text(txt)
    print(f"wrote js/data/{name} ({len(txt) / 1024:.0f} KB)")


write("nfl.js", "NFL_DATA", nfl)
write("cfb.js", "CFB_DATA", cfbd)
write("replays.js", "REPLAY_GAMES", replays)
(OUT / "moments.js").write_text(
    "// Generated by scripts/build_data.py — do not edit by hand.\n"
    f"const AUTO_MOMENTS = {json.dumps(moments, separators=(',', ':'), ensure_ascii=False)};\n"
    f"const MOMENT_FACTS = {json.dumps(facts, separators=(',', ':'), ensure_ascii=False)};\n")
print("wrote js/data/moments.js")
