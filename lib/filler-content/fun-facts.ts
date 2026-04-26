import type { FillerSource } from "./types";

/**
 * Curated trivia. Static so it's instant and offline-safe — fun-facts
 * is the default mode, and the user shouldn't wait on a network round
 * trip during the first thinking gap of every session. Items are
 * one-line, no markdown, no emojis (TTS-friendly).
 *
 * Editing: keep the array additive. The session-dedup tracker keys on
 * the source-prefixed id, so reordering doesn't break replay protection
 * mid-session.
 */

const FACTS: { id: string; text: string }[] = [
  { id: "1", text: "Octopuses have three hearts and blue blood — two pump to the gills, the third to the body." },
  { id: "2", text: "Honey never spoils. Edible jars have been recovered from Egyptian tombs over three thousand years old." },
  { id: "3", text: "A single bolt of lightning is roughly five times hotter than the surface of the sun." },
  { id: "4", text: "Bananas are berries, but strawberries — botanically speaking — are not." },
  { id: "5", text: "The Eiffel Tower can grow more than fifteen centimetres taller in summer when its iron expands." },
  { id: "6", text: "Sharks are older than trees. They've been around for roughly four hundred million years." },
  { id: "7", text: "There are more possible chess games than atoms in the observable universe." },
  { id: "8", text: "Cleopatra lived closer in time to the moon landing than to the building of the Great Pyramid." },
  { id: "9", text: "Wombat droppings are cube-shaped, formed by the unique elasticity of their intestines." },
  { id: "10", text: "Venus is the only planet in the solar system that rotates clockwise as seen from above the north pole." },
  { id: "11", text: "Hot water freezes faster than cold water under specific conditions — known as the Mpemba effect." },
  { id: "12", text: "A group of flamingos is called a flamboyance, which feels exactly right." },
  { id: "13", text: "Humans share about sixty percent of their DNA with bananas." },
  { id: "14", text: "The shortest war in recorded history lasted thirty-eight minutes — between Britain and Zanzibar in 1896." },
  { id: "15", text: "Sloths can hold their breath underwater longer than dolphins — up to forty minutes." },
  { id: "16", text: "There's a coffee bean that's been digested by a civet cat — it sells for hundreds of dollars a pound." },
  { id: "17", text: "The dot over a lowercase i or j is called a tittle." },
  { id: "18", text: "A cloud can weigh more than a million pounds and still float — the air below is heavier still." },
  { id: "19", text: "Crows can recognise individual human faces and hold grudges for years." },
  { id: "20", text: "The first webcam was set up at Cambridge in 1991, pointed at a coffee pot, so people knew if it was empty." },
  { id: "21", text: "Antarctica is technically the world's largest desert — almost no precipitation falls there." },
  { id: "22", text: "Your stomach gets a new lining every three to four days; otherwise its own acid would digest it." },
  { id: "23", text: "Bees can recognise human faces by treating them as funny-looking flowers." },
  { id: "24", text: "The Hawaiian alphabet has only thirteen letters." },
  { id: "25", text: "Pineapples take about two years to grow a single fruit." },
  { id: "26", text: "The unicorn is the national animal of Scotland." },
  { id: "27", text: "Sound travels about four times faster through water than through air." },
  { id: "28", text: "Light from the sun takes a little over eight minutes to reach Earth." },
  { id: "29", text: "Polar bear fur isn't white — each hair is a transparent hollow tube that scatters light." },
  { id: "30", text: "More than half of the world's lakes are in Canada." },
  { id: "31", text: "The longest English word without a vowel is rhythms." },
  { id: "32", text: "A jiffy is an actual unit of time — one one-hundredth of a second." },
  { id: "33", text: "Some turtles can breathe through their backsides — handy when iced over for the winter." },
  { id: "34", text: "An adult human body contains enough iron to make a small nail." },
  { id: "35", text: "The Mona Lisa has no eyebrows, which was the fashion in Renaissance Florence." },
  { id: "36", text: "There are more than seventeen hundred species of fungi that glow in the dark." },
  { id: "37", text: "Mount Everest grows roughly four millimetres taller each year as the Indian plate keeps pushing." },
  { id: "38", text: "A snail can sleep for three years at a stretch when conditions get rough." },
  { id: "39", text: "The total weight of all the ants on Earth is roughly equal to the total weight of all humans." },
  { id: "40", text: "Saturn would float if you could find a bathtub big enough — it's less dense than water." },
];

export const funFactsSource: FillerSource = {
  id: "fun-facts",
  async fetchItems() {
    return FACTS.map((f) => ({
      id: f.id,
      text: f.text,
      sourceId: "fun-facts",
    }));
  },
};
