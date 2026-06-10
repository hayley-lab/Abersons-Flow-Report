function generateSeasons() {
  const year = new Date().getFullYear();
  const seasons = [];

  // Show current year + 1 ahead, back to 2025
  for (let y = year + 1; y >= 2025; y--) {
    const yy = String(y).slice(-2);
    if (y <= 2025) {
      // Historical — no pre-seasons
      seasons.push({ id: `fall${yy}`, name: `Fall ${y}` });
      seasons.push({ id: `spring${yy}`, name: `Spring ${y}` });
    } else if (y === 2026) {
      // Transition year — fall combined (straddles old/new system), no pre-spring
      seasons.push({ id: `fall${yy}`, name: `Fall ${y}` });
      seasons.push({ id: `spring${yy}`, name: `Spring ${y}` });
    } else {
      // Fully in LS — main season first, pre-season below it
      seasons.push({ id: `fall${yy}`, name: `Fall ${y}` });
      seasons.push({ id: `prefall${yy}`, name: `Pre-Fall ${y}` });
      seasons.push({ id: `spring${yy}`, name: `Spring ${y}` });
      seasons.push({ id: `prespring${yy}`, name: `Pre-Spring ${y}` });
    }
  }

  return seasons;
}

export const SEASONS = generateSeasons();
