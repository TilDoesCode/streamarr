import { useLocalSearchParams } from 'expo-router';

import { SeriesScreen } from '@/screens/detail/series-screen';

/** Keyed per series: a deep link from one detail to another must not keep the old page's TV focus memory. */
export default function SeriesRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SeriesScreen key={id} />;
}
