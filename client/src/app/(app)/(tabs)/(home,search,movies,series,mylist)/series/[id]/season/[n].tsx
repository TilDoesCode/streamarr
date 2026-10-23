import { SeasonScreen } from '@/screens/detail/season-screen';
import { SeriesStage } from '@/screens/detail/series-stage';
import { useShell } from '@/shell/use-shell';

/** Large screens: the series Bühne with this season preselected; phones keep the season page. */
export default function SeasonRoute() {
  return useShell().large ? <SeriesStage /> : <SeasonScreen />;
}
