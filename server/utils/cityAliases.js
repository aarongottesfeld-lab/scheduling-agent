'use strict';

// Canonical city name normalization map.
// Maps user-typed neighborhood / shorthand strings to canonical city names.
// Entries are lowercase to allow case-insensitive matching.
const CITY_ALIASES = {
  'nyc':               'New York City',
  'new york city':     'New York City',
  'new york':          'New York City',
  'manhattan':         'New York City',
  'brooklyn':          'Brooklyn',
  'queens':            'Queens',
  'bronx':             'Bronx',
  'staten island':     'Staten Island',
  'los angeles':       'Los Angeles',
  'la':                'Los Angeles',
  'san francisco':     'San Francisco',
  'sf':                'San Francisco',
  'chicago':           'Chicago',
  'washington dc':     'Washington DC',
  'washington d.c':    'Washington DC',
  'dc':                'Washington DC',
  'miami':             'Miami',
  'boston':            'Boston',
  'seattle':           'Seattle',
  'austin':            'Austin',
  'denver':            'Denver',
  'atlanta':           'Atlanta',
  'dallas':            'Dallas',
  'houston':           'Houston',
  'philadelphia':      'Philadelphia',
  'portland':          'Portland',
  'nashville':         'Nashville',
  'las vegas':         'Las Vegas',
  'phoenix':           'Phoenix',
};

module.exports = { CITY_ALIASES };
