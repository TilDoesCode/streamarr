// Dev World fixture titles (server/tests/Streamarr.DevWorld/fixtures/catalog.json) for the gallery.
import type { CatalogSpec } from '@/components/spec';

import auroraSamples from './gallery-samples.json';
import type { Language } from '@/i18n';

export type GalleryEpisode = {
  season: number;
  episode: number;
  title: string;
  airDate: string | null;
  runtimeMinutes: number | null;
  still: string | null;
  overview: string | null;
};

export type GalleryTitle = {
  key: string;
  kind: 'movie' | 'series';
  title: string;
  year: number;
  runtimeMinutes: number | null;
  rating: string | null;
  genres: Record<Language, string[]>;
  overview: Record<Language, string>;
  poster: string | null;
  backdrop: string | null;
  backdropLarge: string | null;
  seasons?: number;
  episodes?: GalleryEpisode[];
};

export const GALLERY_TITLES: GalleryTitle[] = [
  {
    key: 'big-buck-bunny',
    kind: 'movie',
    title: 'Big Buck Bunny',
    year: 2008,
    runtimeMinutes: 8,
    rating: '6',
    genres: {
      en: ['Animation', 'Comedy', 'Family'],
      de: ['Animation', 'Komödie', 'Familie'],
    },
    overview: {
      en: "Follow a day of the life of Big Buck Bunny when he meets three bullying rodents: Frank, Rinky, and Gamera. The rodents amuse themselves by harassing helpless creatures by throwing fruits, nuts and rocks at them. After the deaths of two of Bunny's favorite butterflies, and an offensive attack on Bunny himself, Bunny sets aside his gentle nature and orchestrates a complex plan for revenge.",
      de: 'Der Hauptcharakter ist ein ungewöhnlich großes und fülliges Kaninchen („Big Buck Bunny“), das sich zu Beginn des Films an Blumen und Schmetterlingen erfreut. Als jedoch das Flughörnchen Frank, das Eichhörnchen Rinky und das Chinchilla Gamera auftauchen, zwei Schmetterlinge töten und das Kaninchen mit Früchten und Nüssen bewerfen, beschließt es, seine Sanftmütigkeit abzulegen und an den Nagetieren Rache zu nehmen. Dazu baut es verschiedene Fallen auf.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/i9jJzvoXET4D9pOkoEwncSdNNER.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/xtdybjRRZ15mCrPOvEld305myys.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/xtdybjRRZ15mCrPOvEld305myys.jpg',
  },
  {
    key: 'sintel',
    kind: 'movie',
    title: 'Sintel',
    year: 2010,
    runtimeMinutes: 14,
    rating: 'PG',
    genres: {
      en: ['Animation', 'Fantasy'],
      de: ['Animation', 'Fantasy'],
    },
    overview: {
      en: 'A wandering warrior finds an unlikely friend in the form of a young dragon. The two develop a close bond, until one day the dragon is snatched away. She then sets out on a relentless quest to reclaim her friend, finding in the end that her quest exacts a far greater price than she had ever imagined.',
      de: 'Der Einstieg des Films ist der Überfall eines Drachentöters auf die durch eine verschneite Landschaft streifende, junge, weibliche Hauptfigur Sintel. Bei dem Überfall scheint sie ihrem Angreifer hoffnungslos unterlegen, kann jedoch seinen Speerattacken ausweichen und ihn mit ihrem Messer verwunden, wodurch er seinen Speer fallen lässt. Als er ungestüm auf sie zuläuft kann sie den Speer aufrichten, wodurch er ihn sich selbst in den Bauch rammt und tot umfällt. Sintel ist jedoch durch die Strapazen und den Überfall so geschwächt, dass sie nach einigen Schritten erschöpft im Schnee liegen bleibt und bewusstlos wird.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/l98Zns4oQe1BSvbF4hJ8oL6VSf0.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/msqeiEyIRpPAtrCeRGFNZQ9tkJL.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/msqeiEyIRpPAtrCeRGFNZQ9tkJL.jpg',
  },
  {
    key: 'tears-of-steel',
    kind: 'movie',
    title: 'Tears of Steel',
    year: 2012,
    runtimeMinutes: 12,
    rating: 'NR',
    genres: {
      en: ['Science Fiction', 'Animation'],
      de: ['Science Fiction', 'Animation'],
    },
    overview: {
      en: 'The film’s premise is about a group of warriors and scientists, who gathered at the “Oude Kerk” in Amsterdam to stage a crucial event from the past, in a desperate attempt to rescue the world from destructive robots.',
      de: 'Tears of Steel ist ein computergenerierter Kurzfilm, der im Rahmen des Filmprojektes Mango entstanden ist. Dieses Projekt wurde durch die Blender Foundation produziert und dient der Weiterentwicklung und Erprobung freier Software, insbesondere der 3D-Grafiksoftware Blender. Der Film wurde am 26. September 2012 auf der Projekthomepage veröffentlicht.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/8qy3jRmaHR7f8VZh3iXCqCWfFsH.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/fOy6SL5Zs2PFcNXwqEPIDPrLB1q.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/fOy6SL5Zs2PFcNXwqEPIDPrLB1q.jpg',
  },
  {
    key: 'elephants-dream',
    kind: 'movie',
    title: 'Elephants Dream',
    year: 2006,
    runtimeMinutes: 11,
    rating: 'NR',
    genres: {
      en: ['Animation', 'Science Fiction'],
      de: ['Animation', 'Science Fiction'],
    },
    overview: {
      en: 'Elephants Dream is the story of two strange characters exploring a capricious and seemingly infinite machine. The elder, Proog, acts as a tour-guide and protector, happily showing off the sights and dangers of the machine to his initially curious but increasingly skeptical protege Emo. As their journey unfolds we discover signs that the machine is not all Proog thinks it is, and his guiding takes on a more desperate aspect. Elephants Dream is a story about communication and fiction, made purposefully open-ended as the world’s first 3D animated “Open movie”. The film itself is released under the Creative Commons license, along with the entirety of the production files used to make it (roughly 7 Gigabytes of data). The software used to make the movie is the free/open source animation suite Blender along with other open source software, thus allowing the movie to be remade, remixed and re-purposed with only a computer and the data on the DVD or download.',
      de: 'Emo und Proog befinden sich in einer riesigen surrealen Maschine. Der junge Emo ist verschüchtert und ruhig. Zudem scheint er Angst zu haben.Der alte Proog hingegen scheint die Maschine zu verstehen. Er deutet die merkwürdigen Dinge die geschehen und findet die scheinbar sicheren Wege.Je länger die beiden aber durch die Maschine irren, desto größer wird Emos Zweifel an Proog und der Maschine...',
    },
    poster: 'https://image.tmdb.org/t/p/w342/9zROtU9TkpZQrOuEaMAp68FOWLK.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/9bJDwuhza19HQcYA99FeslLYmUm.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/9bJDwuhza19HQcYA99FeslLYmUm.jpg',
  },
  {
    key: 'cosmos-laundromat',
    kind: 'movie',
    title: 'Cosmos Laundromat',
    year: 2015,
    runtimeMinutes: 12,
    rating: 'G',
    genres: {
      en: ['Animation', 'Fantasy'],
      de: ['Animation', 'Fantasy'],
    },
    overview: {
      en: 'On a desolate island, a suicidal sheep named Franck meets his fate…in the form of a quirky salesman named Victor, who offers him the gift of a lifetime. The gift is many lifetimes, actually, in many different worlds – each lasting just a few minutes. In the sequel to the pilot, Franck will find a new reason to live…in the form of a bewitching female adventurer named Tara, who awakens his long-lost lust for life. But can Franck keep up with her?',
      de: 'Auf einer trostlosen Insel begegnet ein selbstmörderisches Schaf namens Franck seinem Schicksal, denn es bekommt von dem mysteriösen Geschäftsmann Victor eine Maschine geschenkt, mit der es neue Abenteuer in anderen Welten erleben kann.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/5ZXi0oitpEgAdoJglFTc5SZF9nt.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/f2wABsgj2lIR2dkDEfBZX8p4Iyk.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/f2wABsgj2lIR2dkDEfBZX8p4Iyk.jpg',
  },
  {
    key: 'sprite-fright',
    kind: 'movie',
    title: 'Sprite Fright',
    year: 2024,
    runtimeMinutes: 11,
    rating: 'PG-13',
    genres: {
      en: ['Animation', 'Horror', 'Comedy'],
      de: ['Animation', 'Horror', 'Komödie'],
    },
    overview: {
      en: 'Set in 80’s-Britain, when a group of rowdy teenagers trek into an isolated forest, they discover peaceful mushroom creatures that turn out to be an unexpected force of nature.',
      de: 'Set in 80’s-Britain, when a group of rowdy teenagers trek into an isolated forest, they discover peaceful mushroom creatures that turn out to be an unexpected force of nature.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/AjWJQOogG4Irpff6K49tzrUTb1s.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/aCMT1okuiKFnyKHdCOez66rJKyT.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/aCMT1okuiKFnyKHdCOez66rJKyT.jpg',
  },
  {
    key: 'night-of-the-living-dead',
    kind: 'movie',
    title: 'Night of the Living Dead',
    year: 1968,
    runtimeMinutes: 96,
    rating: '16',
    genres: {
      en: ['Horror', 'Thriller', 'Science Fiction'],
      de: ['Horror', 'Thriller', 'Science Fiction'],
    },
    overview: {
      en: 'A ragtag group barricade themselves in an old Pennsylvania farmhouse to remain safe from a horde of flesh-eating ghouls ravaging the Northeast.',
      de: 'In der Provinz von Pennsylvania steigen Tote aus ihren Gräbern und machen sich mit kannibalistischen Motiven über die Landbevölkerung her. Eine Handvoll Durchreisender flüchtet in das abgelegene Haus einer höchst nervösen Kleinfamilie, wo man sich alsbald einer massiven Belagerung ausgesetzt sieht. Im Laufe einer turbulenten Nacht segnen sämtliche Eingeschlossenen das Zeitliche, wobei der letzte Überlebende als der einzige rational agierende Charakter bezeichnenderweise einer Kugel aus Polizeigewehren zum Opfer fällt.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/rb2NWyb008u1EcKCOyXs2Nmj0ra.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/5KtmBSqFtHY3I9t8lgH27Mc0bqY.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/5KtmBSqFtHY3I9t8lgH27Mc0bqY.jpg',
  },
  {
    key: 'pioneer-one',
    kind: 'series',
    title: 'Pioneer One',
    year: 2010,
    runtimeMinutes: 35,
    rating: 'NR',
    genres: {
      en: ['Sci-Fi & Fantasy', 'War & Politics', 'Drama'],
      de: ['Sci-Fi & Fantasy', 'War & Politics', 'Drama'],
    },
    overview: {
      en: 'A Cold War relic returns amid fears of terrorism but turns out to be a forgotten Soviet space mission. What it brings back will have implications for the entire world.',
      de: 'A Cold War relic returns amid fears of terrorism but turns out to be a forgotten Soviet space mission. What it brings back will have implications for the entire world.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/p53wbsukyhJ8TieisoeU1zZr9iA.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/aMUc1h3nXYZnou7P9HRdJgW2zw2.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/aMUc1h3nXYZnou7P9HRdJgW2zw2.jpg',
    seasons: 1,
    episodes: [
      {
        season: 1,
        episode: 1,
        title: 'Earthfall',
        airDate: '2010-06-16',
        runtimeMinutes: 35,
        still: null,
        overview:
          'An object from space spreads radiation over North America. Fearing terrorism, U.S. Homeland Security agents are dispatched to investigate and contain the damage. What they discover is a forgotten relic of the old Soviet space program, whose return to Earth will have implications for the entire world.',
      },
      {
        season: 1,
        episode: 2,
        title: 'The Man From Mars',
        airDate: '2010-06-25',
        runtimeMinutes: 35,
        still: null,
        overview:
          'Hired Mars expert Dr. Zachary Walzer (Jack Haley) fights to prove the validity of the Mars story. Can he convince the government to mount a manned mission to Mars? Agent in charge Tom Taylor (James Rich) faces pressure from both the Canadians and his own superiors, and has to make a call.',
      },
      {
        season: 1,
        episode: 3,
        title: 'Alone in the Night',
        airDate: '2011-03-28',
        runtimeMinutes: 35,
        still: null,
        overview:
          'Now quarantined to the Calgary base for two weeks, Taylor and his team have bought time to get answers from the supposed Martian cosmonaut. But who can get him to talk?',
      },
      {
        season: 1,
        episode: 4,
        title: 'Triangular Diplomacy',
        airDate: '2011-04-28',
        runtimeMinutes: 35,
        still: null,
        overview:
          'As the media begins to question the story about the crashed satellite, Secretary McClellan (Einar Gunn) starts to play hardball with the Russians in pursuit of his own truth. But everything hinges on what Yuri (Aleksandr Evtushenko), the frightened boy at the center of it all, might have to say...',
      },
      {
        season: 1,
        episode: 5,
        title: 'Sea Change',
        airDate: '2011-10-05',
        runtimeMinutes: 35,
        still: null,
        overview:
          'When an unannounced visitor breaks in to the Calgary base with just days left in the Quarantine, tensions are higher than ever. The fate of Yuri and everyone on Tom Taylor’s team is about to be decided in this, the penultimate episode of the first season.',
      },
      {
        season: 1,
        episode: 6,
        title: 'War of the World',
        airDate: '2011-12-13',
        runtimeMinutes: 35,
        still: null,
        overview:
          "Taylor prepares to go to the public with Yuri's story, and everyone discovers the consequences of their actions in the conclusion to Pioneer One's first season.",
      },
    ],
  },
  {
    key: 'sherlock',
    kind: 'series',
    title: 'Sherlock',
    year: 2010,
    runtimeMinutes: 89,
    rating: '12',
    genres: {
      en: ['Crime', 'Drama', 'Mystery'],
      de: ['Krimi', 'Drama', 'Mystery'],
    },
    overview: {
      en: 'A modern update finds the famous sleuth and his doctor partner solving crime in 21st century London.',
      de: 'Sherlock ist eine britische Fernsehserie der BBC. Die Autoren Steven Moffat und Mark Gatiss versetzen dabei die von Sir Arthur Conan Doyle geschriebenen Detektivgeschichten in einen modernen Kontext und lassen Sherlock Holmes, gemeinsam mit seinem Assistenten Dr. Watson, im heutigen London ermitteln.',
    },
    poster: 'https://image.tmdb.org/t/p/w342/7WTsnHkbA0FaG6R9twfFde0I9hl.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/8rvLEmdI4gLrMO1rLqbNdnNcPFE.jpg',
    backdropLarge: 'https://image.tmdb.org/t/p/w1280/8rvLEmdI4gLrMO1rLqbNdnNcPFE.jpg',
    seasons: 3,
    episodes: [
      {
        season: 1,
        episode: 1,
        title: 'A Study in Pink',
        airDate: '2010-07-25',
        runtimeMinutes: 88,
        still: 'https://image.tmdb.org/t/p/w300/u8xvgVzTQjAeRu68sI9JJHeQSuA.jpg',
        overview:
          'A war hero, invalided home from Afghanistan, meets a strange but charismatic genius who is looking for a flatmate; it is London, 2010, and Dr Watson and Sherlock Holmes are meeting for the first time. A string of impossible suicides has Scotland Yard baffled - and only one man can help.',
      },
      {
        season: 1,
        episode: 2,
        title: 'The Blind Banker',
        airDate: '2010-08-01',
        runtimeMinutes: 89,
        still: 'https://image.tmdb.org/t/p/w300/cp1mf1pwb8F7NcuCJkzcfxIkZw2.jpg',
        overview:
          "A mysterious cipher is being scrawled on the walls around London. The first person to see the cipher is dead within hours of reading it. Sherlock plunges into a world of codes and symbols, consulting with London's best graffiti artists. He soon learns that the city is in the grip a gang of international smugglers, a secret society called the Black Lotus.",
      },
      {
        season: 1,
        episode: 3,
        title: 'The Great Game',
        airDate: '2010-08-08',
        runtimeMinutes: 90,
        still: 'https://image.tmdb.org/t/p/w300/inRnf07LWmlT5Z3KkS4iWlBX48x.jpg',
        overview:
          'A strange clue in an empty room, a blood-soaked car, a priceless Old Master, a deranged bomber. With the clock ticking, the curtain rises on a battle of wits between Sherlock, John and the shadowy stranger who seems to know all the answers...',
      },
      {
        season: 2,
        episode: 1,
        title: 'A Scandal in Belgravia',
        airDate: '2012-01-01',
        runtimeMinutes: 90,
        still: 'https://image.tmdb.org/t/p/w300/9fmNcR20uEnMeAKmUucJnCPeUJg.jpg',
        overview:
          'Blackmail threatens the monarchy and Sherlock is about to meet the woman who beats him.',
      },
      {
        season: 2,
        episode: 2,
        title: 'The Hounds of Baskerville',
        airDate: '2012-01-08',
        runtimeMinutes: 89,
        still: 'https://image.tmdb.org/t/p/w300/vjUsJUsF5RcTRKn2prGHCW9Nxro.jpg',
        overview:
          "A hound from hell. Sherlock's most famous case. But is a monster really stalking Dartmoor?",
      },
      {
        season: 2,
        episode: 3,
        title: 'The Reichenbach Fall',
        airDate: '2012-01-15',
        runtimeMinutes: 89,
        still: 'https://image.tmdb.org/t/p/w300/PVxRD2JqT2QM4t1Cih0v2AoRSR.jpg',
        overview:
          'The return of Moriarty. The crime of the century. Can Sherlock possibly survive?',
      },
      {
        season: 3,
        episode: 1,
        title: 'The Empty Hearse',
        airDate: '2014-01-01',
        runtimeMinutes: 87,
        still: 'https://image.tmdb.org/t/p/w300/zXsOogQ8BVyvWUR2zgs6NBxkReX.jpg',
        overview:
          "Two years on from reports of his Reichenbach Fall demise, Sherlock resurfaces as London comes under threat of a huge terrorist attack. John, though, has mixed feelings about his friend's shocking return.",
      },
      {
        season: 3,
        episode: 2,
        title: 'The Sign of Three',
        airDate: '2014-01-05',
        runtimeMinutes: 87,
        still: 'https://image.tmdb.org/t/p/w300/ca3ayuzXGpxpALFlcsVsXTQau9G.jpg',
        overview:
          'Sherlock faces his biggest challenge of all – delivering a Best Man’s speech on John’s wedding day! But all isn’t quite as it seems. Mortal danger stalks the reception – and someone might not make it to the happy couple’s first dance. Sherlock must thank the bridesmaids, solve the case and stop a killer.',
      },
      {
        season: 3,
        episode: 3,
        title: 'His Last Vow',
        airDate: '2014-01-12',
        runtimeMinutes: 90,
        still: 'https://image.tmdb.org/t/p/w300/5phdYWQXMwn9cBUPzUt1Z3oie4K.jpg',
        overview:
          'A case of stolen letters leads Sherlock Holmes into a long conflict with Charles Augustus Magnussen, the Napoleon of blackmail, and the one man he truly hates. But how do you tackle a foe who knows the personal weakness of every person of importance in the Western world?',
      },
    ],
  },
];

/** R0-style palette and spec samples (mockup tints) for the Aurora gallery; null = not extracted yet. */
export const AURORA_SAMPLES: Record<
  string,
  { tint: string | null; tint2: string | null; spec: CatalogSpec | null }
> = auroraSamples;
