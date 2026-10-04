import { useLocalSearchParams } from 'expo-router';

import { MovieScreen } from '@/screens/detail/movie-screen';

/** Keyed per title: a deep link from one detail to another must not keep the old page's TV focus memory. */
export default function MovieRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MovieScreen key={id} />;
}
