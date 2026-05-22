/**
 * Pario Quantitative Types registry.
 *
 * A single flat registry of physical quantities.  Each entry names a quantity,
 * describes it, and lists its valid units.  Where multiple quantities share the
 * same set of units (e.g. Humidity and Density) they reference the same const
 * object — no string-based linking required.
 *
 * Literal-union types are derived automatically via `as const` so developers
 * get full autocomplete without defining anything themselves.
 *
 * Inspired by Azure DTDL QuantitativeTypes v2.
 */

import type { QuantitativeType, Unit } from "./types"

// ═════════════════════════════════════════════════════════════
// Shared unit sets
//
// When several quantities accept the same units, define the set
// once here and reference it from each quantity entry below.
// ═════════════════════════════════════════════════════════════

const angleUnits = {
  degreeOfArc: { name: "Degree of Arc", symbol: "°" },
  minuteOfArc: { name: "Minute of Arc", symbol: "′" },
  radian: { name: "Radian", symbol: "rad" },
  secondOfArc: { name: "Second of Arc", symbol: "″" },
  turn: { name: "Turn", symbol: "rev" },
} as const satisfies Record<string, Unit>

const densityUnits = {
  gramPerCubicMetre: { name: "Gram per Cubic Metre", symbol: "g/m³" },
  kilogramPerCubicMetre: { name: "Kilogram per Cubic Metre", symbol: "kg/m³" },
  microgramPerCubicMetre: { name: "Microgram per Cubic Metre", symbol: "µg/m³" },
  milligramPerCubicMetre: { name: "Milligram per Cubic Metre", symbol: "mg/m³" },
} as const satisfies Record<string, Unit>

const forceUnits = {
  newton: { name: "Newton", symbol: "N" },
  ounce: { name: "Ounce", symbol: "oz" },
  pound: { name: "Pound", symbol: "lbf" },
  ton: { name: "Ton", symbol: "t" },
} as const satisfies Record<string, Unit>

const lengthUnits = {
  astronomicalUnit: { name: "Astronomical Unit", symbol: "AU" },
  centimetre: { name: "Centimetre", symbol: "cm" },
  foot: { name: "Foot", symbol: "ft" },
  inch: { name: "Inch", symbol: "in" },
  kilometre: { name: "Kilometre", symbol: "km" },
  metre: { name: "Metre", symbol: "m" },
  micrometre: { name: "Micrometre", symbol: "µm" },
  mile: { name: "Mile", symbol: "mi" },
  millimetre: { name: "Millimetre", symbol: "mm" },
  nanometre: { name: "Nanometre", symbol: "nm" },
  nauticalMile: { name: "Nautical Mile", symbol: "nmi" },
} as const satisfies Record<string, Unit>

const powerUnits = {
  britishThermalUnitPerHour: { name: "British Thermal Unit per Hour", symbol: "BTU/h" },
  gigajoulePerHour: { name: "Gigajoule per Hour", symbol: "GJ/h" },
  gigawatt: { name: "Gigawatt", symbol: "GW" },
  horsepower: { name: "Horsepower", symbol: "hp" },
  joulePerHour: { name: "Joule per Hour", symbol: "J/h" },
  joulePerSecond: { name: "Joule per Second", symbol: "J/s" },
  kiloBritishThermalUnitPerHour: { name: "Kilo British Thermal Unit per Hour", symbol: "kBTU/h" },
  kilojoulePerHour: { name: "Kilojoule per Hour", symbol: "kJ/h" },
  kilojoulePerSecond: { name: "Kilojoule per Second", symbol: "kJ/s" },
  kilowatt: { name: "Kilowatt", symbol: "kW" },
  kilowattHourPerYear: { name: "Kilowatt Hour per Year", symbol: "kWh/yr" },
  megajoulePerHour: { name: "Megajoule per Hour", symbol: "MJ/h" },
  megawatt: { name: "Megawatt", symbol: "MW" },
  microwatt: { name: "Microwatt", symbol: "µW" },
  milliwatt: { name: "Milliwatt", symbol: "mW" },
  tonOfRefrigeration: { name: "Ton of Refrigeration", symbol: "TR" },
  watt: { name: "Watt", symbol: "W" },
} as const satisfies Record<string, Unit>

const unitlessUnits = {
  partsPerBillion: { name: "Parts per Billion", symbol: "ppb" },
  partsPerMillion: { name: "Parts per Million", symbol: "ppm" },
  partsPerQuadrillion: { name: "Parts per Quadrillion", symbol: "ppq" },
  partsPerTrillion: { name: "Parts per Trillion", symbol: "ppt" },
  percent: { name: "Percent", symbol: "%" },
  unity: { name: "Unity", symbol: "" },
} as const satisfies Record<string, Unit>

// ═════════════════════════════════════════════════════════════
// Registry
// ═════════════════════════════════════════════════════════════

/** Complete registry of quantitative types, keyed by semantic type id. */
export const quantitativeTypes = {
  Acceleration: {
    name: "Acceleration",
    description: "Rate of change of velocity.",
    units: {
      centimetrePerSecondSquared: { name: "Centimetre per Second Squared", symbol: "cm/s²" },
      gForce: { name: "G-Force", symbol: "g" },
      metrePerSecondSquared: { name: "Metre per Second Squared", symbol: "m/s²" },
    },
  },
  Angle: {
    name: "Angle",
    description: "Measure of rotation between two rays.",
    units: angleUnits,
  },
  AngularAcceleration: {
    name: "Angular Acceleration",
    description: "Rate of change of angular velocity.",
    units: {
      radianPerSecondSquared: { name: "Radian per Second Squared", symbol: "rad/s²" },
    },
  },
  AngularVelocity: {
    name: "Angular Velocity",
    description: "Rate of rotation around an axis.",
    units: {
      degreePerSecond: { name: "Degree per Second", symbol: "°/s" },
      radianPerSecond: { name: "Radian per Second", symbol: "rad/s" },
      revolutionPerMinute: { name: "Revolution per Minute", symbol: "rpm" },
      revolutionPerSecond: { name: "Revolution per Second", symbol: "rps" },
    },
  },
  ApparentEnergy: {
    name: "Apparent Energy",
    description: "Integral of apparent power over time.",
    units: {
      gigavoltAmpereHour: { name: "Gigavolt Ampere Hour", symbol: "GVAh" },
      kilovoltAmpereHour: { name: "Kilovolt Ampere Hour", symbol: "kVAh" },
      megavoltAmpereHour: { name: "Megavolt Ampere Hour", symbol: "MVAh" },
      voltAmpereHour: { name: "Volt Ampere Hour", symbol: "VAh" },
    },
  },
  ApparentPower: {
    name: "Apparent Power",
    description: "Product of RMS voltage and RMS current in an AC circuit.",
    units: {
      gigavoltAmpere: { name: "Gigavolt Ampere", symbol: "GVA" },
      kilovoltAmpere: { name: "Kilovolt Ampere", symbol: "kVA" },
      megavoltAmpere: { name: "Megavolt Ampere", symbol: "MVA" },
      millivoltAmpere: { name: "Millivolt Ampere", symbol: "mVA" },
      voltAmpere: { name: "Volt Ampere", symbol: "VA" },
    },
  },
  Area: {
    name: "Area",
    description: "Extent of a two-dimensional surface.",
    units: {
      acre: { name: "Acre", symbol: "ac" },
      hectare: { name: "Hectare", symbol: "ha" },
      squareCentimetre: { name: "Square Centimetre", symbol: "cm²" },
      squareFoot: { name: "Square Foot", symbol: "ft²" },
      squareInch: { name: "Square Inch", symbol: "in²" },
      squareKilometre: { name: "Square Kilometre", symbol: "km²" },
      squareMetre: { name: "Square Metre", symbol: "m²" },
      squareMillimetre: { name: "Square Millimetre", symbol: "mm²" },
    },
  },
  Capacitance: {
    name: "Capacitance",
    description: "Ability to store an electric charge.",
    units: {
      farad: { name: "Farad", symbol: "F" },
      microfarad: { name: "Microfarad", symbol: "µF" },
      millifarad: { name: "Millifarad", symbol: "mF" },
      nanofarad: { name: "Nanofarad", symbol: "nF" },
      picofarad: { name: "Picofarad", symbol: "pF" },
    },
  },
  Concentration: {
    name: "Concentration",
    description: "Amount of substance per unit volume or mass (dimensionless ratio).",
    units: unitlessUnits,
  },
  Current: {
    name: "Current",
    description: "Flow of electric charge.",
    units: {
      ampere: { name: "Ampere", symbol: "A" },
      kiloampere: { name: "Kiloampere", symbol: "kA" },
      microampere: { name: "Microampere", symbol: "µA" },
      milliampere: { name: "Milliampere", symbol: "mA" },
    },
  },
  DataRate: {
    name: "Data Rate",
    description: "Amount of data transferred per unit time.",
    units: {
      bitPerSecond: { name: "Bit per Second", symbol: "bps" },
      bytePerSecond: { name: "Byte per Second", symbol: "B/s" },
      exbibitPerSecond: { name: "Exbibit per Second", symbol: "Eibit/s" },
      exbibytePerSecond: { name: "Exbibyte per Second", symbol: "EiB/s" },
      gibibitPerSecond: { name: "Gibibit per Second", symbol: "Gibit/s" },
      gibibytePerSecond: { name: "Gibibyte per Second", symbol: "GiB/s" },
      kibibitPerSecond: { name: "Kibibit per Second", symbol: "Kibit/s" },
      kibibytePerSecond: { name: "Kibibyte per Second", symbol: "KiB/s" },
      mebibitPerSecond: { name: "Mebibit per Second", symbol: "Mibit/s" },
      mebibytePerSecond: { name: "Mebibyte per Second", symbol: "MiB/s" },
      tebibitPerSecond: { name: "Tebibit per Second", symbol: "Tibit/s" },
      tebibytePerSecond: { name: "Tebibyte per Second", symbol: "TiB/s" },
      yobibitPerSecond: { name: "Yobibit per Second", symbol: "Yibit/s" },
      yobibytePerSecond: { name: "Yobibyte per Second", symbol: "YiB/s" },
      zebibitPerSecond: { name: "Zebibit per Second", symbol: "Zibit/s" },
      zebibytePerSecond: { name: "Zebibyte per Second", symbol: "ZiB/s" },
    },
  },
  DataSize: {
    name: "Data Size",
    description: "Amount of digital information.",
    units: {
      bit: { name: "Bit", symbol: "bit" },
      byte: { name: "Byte", symbol: "B" },
      exbibit: { name: "Exbibit", symbol: "Eibit" },
      exbibyte: { name: "Exbibyte", symbol: "EiB" },
      gibibit: { name: "Gibibit", symbol: "Gibit" },
      gibibyte: { name: "Gibibyte", symbol: "GiB" },
      kibibit: { name: "Kibibit", symbol: "Kibit" },
      kibibyte: { name: "Kibibyte", symbol: "KiB" },
      mebibit: { name: "Mebibit", symbol: "Mibit" },
      mebibyte: { name: "Mebibyte", symbol: "MiB" },
      tebibit: { name: "Tebibit", symbol: "Tibit" },
      tebibyte: { name: "Tebibyte", symbol: "TiB" },
      yobibit: { name: "Yobibit", symbol: "Yibit" },
      yobibyte: { name: "Yobibyte", symbol: "YiB" },
      zebibit: { name: "Zebibit", symbol: "Zibit" },
      zebibyte: { name: "Zebibyte", symbol: "ZiB" },
    },
  },
  Density: {
    name: "Density",
    description: "Mass per unit volume.",
    units: densityUnits,
  },
  Distance: {
    name: "Distance",
    description: "Scalar measure of how far apart two points are.",
    units: lengthUnits,
  },
  ElectricCharge: {
    name: "Electric Charge",
    description: "Quantity of electric charge.",
    units: {
      ampereHour: { name: "Ampere Hour", symbol: "Ah" },
      coulomb: { name: "Coulomb", symbol: "C" },
      milliampereHour: { name: "Milliampere Hour", symbol: "mAh" },
    },
  },
  Energy: {
    name: "Energy",
    description: "Capacity to do work.",
    units: {
      britishThermalUnit: { name: "British Thermal Unit", symbol: "BTU" },
      electronvolt: { name: "Electronvolt", symbol: "eV" },
      gigajoule: { name: "Gigajoule", symbol: "GJ" },
      gigawattHour: { name: "Gigawatt Hour", symbol: "GWh" },
      joule: { name: "Joule", symbol: "J" },
      kiloBritishThermalUnit: { name: "Kilo British Thermal Unit", symbol: "kBTU" },
      kilojoule: { name: "Kilojoule", symbol: "kJ" },
      kilowattHour: { name: "Kilowatt Hour", symbol: "kWh" },
      megaelectronvolt: { name: "Megaelectronvolt", symbol: "MeV" },
      megajoule: { name: "Megajoule", symbol: "MJ" },
      megawattHour: { name: "Megawatt Hour", symbol: "MWh" },
      milliwattHour: { name: "Milliwatt Hour", symbol: "mWh" },
      terawattHour: { name: "Terawatt Hour", symbol: "TWh" },
      wattHour: { name: "Watt Hour", symbol: "Wh" },
    },
  },
  EnergyRate: {
    name: "Energy Rate",
    description: "Rate of energy transfer or conversion.",
    units: powerUnits,
  },
  Force: {
    name: "Force",
    description: "Interaction that changes the motion of an object.",
    units: forceUnits,
  },
  Frequency: {
    name: "Frequency",
    description: "Number of occurrences per unit time.",
    units: {
      gigahertz: { name: "Gigahertz", symbol: "GHz" },
      hertz: { name: "Hertz", symbol: "Hz" },
      kilohertz: { name: "Kilohertz", symbol: "kHz" },
      megahertz: { name: "Megahertz", symbol: "MHz" },
      millihertz: { name: "Millihertz", symbol: "mHz" },
    },
  },
  Humidity: {
    name: "Humidity",
    description: "Absolute moisture content expressed as mass per volume.",
    units: densityUnits,
  },
  Illuminance: {
    name: "Illuminance",
    description: "Luminous flux incident on a surface per unit area.",
    units: {
      footcandle: { name: "Footcandle", symbol: "fc" },
      lux: { name: "Lux", symbol: "lx" },
    },
  },
  Inductance: {
    name: "Inductance",
    description: "Property of a conductor to oppose change in current.",
    units: {
      henry: { name: "Henry", symbol: "H" },
      microhenry: { name: "Microhenry", symbol: "µH" },
      millihenry: { name: "Millihenry", symbol: "mH" },
    },
  },
  IonizingRadiationDose: {
    name: "Ionizing Radiation Dose",
    description: "Absorbed dose of ionizing radiation.",
    units: {
      gray: { name: "Gray", symbol: "Gy" },
      microgray: { name: "Microgray", symbol: "µGy" },
      microsievert: { name: "Microsievert", symbol: "µSv" },
      milligray: { name: "Milligray", symbol: "mGy" },
      millisievert: { name: "Millisievert", symbol: "mSv" },
      sievert: { name: "Sievert", symbol: "Sv" },
    },
  },
  Irradiance: {
    name: "Irradiance",
    description: "Power of electromagnetic radiation per unit area.",
    units: {
      wattPerSquareMetre: { name: "Watt per Square Metre", symbol: "W/m²" },
    },
  },
  Latitude: {
    name: "Latitude",
    description: "Angular distance north or south of the equator.",
    units: angleUnits,
  },
  Length: {
    name: "Length",
    description: "Measure of a one-dimensional extent.",
    units: lengthUnits,
  },
  Longitude: {
    name: "Longitude",
    description: "Angular distance east or west of the prime meridian.",
    units: angleUnits,
  },
  Luminance: {
    name: "Luminance",
    description: "Luminous intensity per unit area of light in a given direction.",
    units: {
      candelaPerSquareMetre: { name: "Candela per Square Metre", symbol: "cd/m²" },
    },
  },
  Luminosity: {
    name: "Luminosity",
    description: "Total amount of electromagnetic energy emitted per unit time.",
    units: powerUnits,
  },
  LuminousFlux: {
    name: "Luminous Flux",
    description: "Total quantity of visible light emitted by a source.",
    units: {
      lumen: { name: "Lumen", symbol: "lm" },
    },
  },
  LuminousIntensity: {
    name: "Luminous Intensity",
    description: "Luminous flux emitted per unit solid angle.",
    units: {
      candela: { name: "Candela", symbol: "cd" },
    },
  },
  MagneticFlux: {
    name: "Magnetic Flux",
    description: "Total magnetic field passing through an area.",
    units: {
      maxwell: { name: "Maxwell", symbol: "Mx" },
      weber: { name: "Weber", symbol: "Wb" },
    },
  },
  MagneticInduction: {
    name: "Magnetic Induction",
    description: "Magnetic flux density.",
    units: {
      gauss: { name: "Gauss", symbol: "G" },
      tesla: { name: "Tesla", symbol: "T" },
    },
  },
  Mass: {
    name: "Mass",
    description: "Quantity of matter.",
    units: {
      gram: { name: "Gram", symbol: "g" },
      kilogram: { name: "Kilogram", symbol: "kg" },
      massPound: { name: "Pound (mass)", symbol: "lb" },
      microgram: { name: "Microgram", symbol: "µg" },
      milligram: { name: "Milligram", symbol: "mg" },
      slug: { name: "Slug", symbol: "slug" },
      tonne: { name: "Tonne", symbol: "t" },
    },
  },
  MassFlowRate: {
    name: "Mass Flow Rate",
    description: "Mass of substance passing a point per unit time.",
    units: {
      gramPerHour: { name: "Gram per Hour", symbol: "g/h" },
      gramPerSecond: { name: "Gram per Second", symbol: "g/s" },
      kilogramPerHour: { name: "Kilogram per Hour", symbol: "kg/h" },
      kilogramPerSecond: { name: "Kilogram per Second", symbol: "kg/s" },
      massPoundPerHour: { name: "Pound per Hour", symbol: "lb/h" },
    },
  },
  Power: {
    name: "Power",
    description: "Rate of energy transfer or work.",
    units: powerUnits,
  },
  Pressure: {
    name: "Pressure",
    description: "Force applied per unit area.",
    units: {
      bar: { name: "Bar", symbol: "bar" },
      decapascal: { name: "Decapascal", symbol: "daPa" },
      hectopascal: { name: "Hectopascal", symbol: "hPa" },
      inchesOfMercury: { name: "Inches of Mercury", symbol: "inHg" },
      inchesOfWater: { name: "Inches of Water", symbol: "inH₂O" },
      kilopascal: { name: "Kilopascal", symbol: "kPa" },
      millibar: { name: "Millibar", symbol: "mbar" },
      millimetresOfMercury: { name: "Millimetres of Mercury", symbol: "mmHg" },
      pascal: { name: "Pascal", symbol: "Pa" },
      poundPerSquareInch: { name: "Pound per Square Inch", symbol: "psi" },
    },
  },
  Radioactivity: {
    name: "Radioactivity",
    description: "Rate of radioactive decay.",
    units: {
      becquerel: { name: "Becquerel", symbol: "Bq" },
      gigabecquerel: { name: "Gigabecquerel", symbol: "GBq" },
      kilobecquerel: { name: "Kilobecquerel", symbol: "kBq" },
      megabecquerel: { name: "Megabecquerel", symbol: "MBq" },
    },
  },
  ReactiveEnergy: {
    name: "Reactive Energy",
    description: "Integral of reactive power over time.",
    units: {
      gigavoltAmpereReactiveHour: { name: "Gigavolt Ampere Reactive Hour", symbol: "GVARh" },
      kilovoltAmpereReactiveHour: { name: "Kilovolt Ampere Reactive Hour", symbol: "kVARh" },
      megavoltAmpereReactiveHour: { name: "Megavolt Ampere Reactive Hour", symbol: "MVARh" },
      voltAmpereReactiveHour: { name: "Volt Ampere Reactive Hour", symbol: "VARh" },
    },
  },
  ReactivePower: {
    name: "Reactive Power",
    description: "Power oscillating between source and load in an AC circuit.",
    units: {
      gigavoltAmpereReactive: { name: "Gigavolt Ampere Reactive", symbol: "GVAR" },
      kilovoltAmpereReactive: { name: "Kilovolt Ampere Reactive", symbol: "kVAR" },
      megavoltAmpereReactive: { name: "Megavolt Ampere Reactive", symbol: "MVAR" },
      millivoltAmpereReactive: { name: "Millivolt Ampere Reactive", symbol: "mVAR" },
      voltAmpereReactive: { name: "Volt Ampere Reactive", symbol: "VAR" },
    },
  },
  RelativeDensity: {
    name: "Relative Density",
    description: "Ratio of a substance's density to a reference substance.",
    units: unitlessUnits,
  },
  RelativeHumidity: {
    name: "Relative Humidity",
    description: "Ratio of current moisture content to saturation capacity.",
    units: unitlessUnits,
  },
  Resistance: {
    name: "Resistance",
    description: "Opposition to flow of electric current.",
    units: {
      kiloohm: { name: "Kiloohm", symbol: "kΩ" },
      megaohm: { name: "Megaohm", symbol: "MΩ" },
      milliohm: { name: "Milliohm", symbol: "mΩ" },
      ohm: { name: "Ohm", symbol: "Ω" },
    },
  },
  SoundPressure: {
    name: "Sound Pressure",
    description: "Local pressure deviation from ambient caused by sound.",
    units: {
      bel: { name: "Bel", symbol: "B" },
      decibel: { name: "Decibel", symbol: "dB" },
    },
  },
  Temperature: {
    name: "Temperature",
    description: "Degree of hotness or coldness.",
    units: {
      degreeCelsius: { name: "Degree Celsius", symbol: "°C" },
      degreeFahrenheit: { name: "Degree Fahrenheit", symbol: "°F" },
      kelvin: { name: "Kelvin", symbol: "K" },
    },
  },
  Thrust: {
    name: "Thrust",
    description: "Reaction force from expelling mass.",
    units: forceUnits,
  },
  TimeSpan: {
    name: "Time Span",
    description: "Duration of time (numeric, not ISO 8601 calendar duration).",
    units: {
      day: { name: "Day", symbol: "d" },
      hour: { name: "Hour", symbol: "h" },
      microsecond: { name: "Microsecond", symbol: "µs" },
      millisecond: { name: "Millisecond", symbol: "ms" },
      minute: { name: "Minute", symbol: "min" },
      nanosecond: { name: "Nanosecond", symbol: "ns" },
      second: { name: "Second", symbol: "s" },
      year: { name: "Year", symbol: "yr" },
    },
  },
  Torque: {
    name: "Torque",
    description: "Rotational force.",
    units: {
      newtonMetre: { name: "Newton Metre", symbol: "N·m" },
    },
  },
  Velocity: {
    name: "Velocity",
    description: "Speed in a given direction.",
    units: {
      centimetrePerSecond: { name: "Centimetre per Second", symbol: "cm/s" },
      kilometrePerHour: { name: "Kilometre per Hour", symbol: "km/h" },
      kilometrePerSecond: { name: "Kilometre per Second", symbol: "km/s" },
      knot: { name: "Knot", symbol: "kn" },
      metrePerHour: { name: "Metre per Hour", symbol: "m/h" },
      metrePerSecond: { name: "Metre per Second", symbol: "m/s" },
      milePerHour: { name: "Mile per Hour", symbol: "mph" },
      milePerSecond: { name: "Mile per Second", symbol: "mi/s" },
    },
  },
  Voltage: {
    name: "Voltage",
    description: "Electric potential difference.",
    units: {
      kilovolt: { name: "Kilovolt", symbol: "kV" },
      megavolt: { name: "Megavolt", symbol: "MV" },
      microvolt: { name: "Microvolt", symbol: "µV" },
      millivolt: { name: "Millivolt", symbol: "mV" },
      volt: { name: "Volt", symbol: "V" },
    },
  },
  Volume: {
    name: "Volume",
    description: "Extent of a three-dimensional space.",
    units: {
      cubicCentimetre: { name: "Cubic Centimetre", symbol: "cm³" },
      cubicFoot: { name: "Cubic Foot", symbol: "ft³" },
      cubicInch: { name: "Cubic Inch", symbol: "in³" },
      cubicMetre: { name: "Cubic Metre", symbol: "m³" },
      fluidOunce: { name: "Fluid Ounce", symbol: "fl oz" },
      gallon: { name: "Gallon", symbol: "gal" },
      litre: { name: "Litre", symbol: "L" },
      millilitre: { name: "Millilitre", symbol: "mL" },
    },
  },
  VolumeFlowRate: {
    name: "Volume Flow Rate",
    description: "Volume of fluid passing a point per unit time.",
    units: {
      cubicFootPerMinute: { name: "Cubic Foot per Minute", symbol: "cfm" },
      cubicMetrePerHour: { name: "Cubic Metre per Hour", symbol: "m³/h" },
      cubicMetrePerMinute: { name: "Cubic Metre per Minute", symbol: "m³/min" },
      cubicMetrePerSecond: { name: "Cubic Metre per Second", symbol: "m³/s" },
      gallonPerHour: { name: "Gallon per Hour", symbol: "gal/h" },
      gallonPerMinute: { name: "Gallon per Minute", symbol: "gal/min" },
      litrePerHour: { name: "Litre per Hour", symbol: "L/h" },
      litrePerMinute: { name: "Litre per Minute", symbol: "L/min" },
      litrePerSecond: { name: "Litre per Second", symbol: "L/s" },
      millilitrePerHour: { name: "Millilitre per Hour", symbol: "mL/h" },
      millilitrePerMinute: { name: "Millilitre per Minute", symbol: "mL/min" },
      millilitrePerSecond: { name: "Millilitre per Second", symbol: "mL/s" },
    },
  },
} as const satisfies Record<string, QuantitativeType>

// ═════════════════════════════════════════════════════════════
// Derived types
// ═════════════════════════════════════════════════════════════

/** Union of all quantitative type identifiers (semantic type ids). */
export type QuantitativeTypeId = keyof typeof quantitativeTypes

/**
 * Extract the unit id union for a given quantitative type.
 *
 * @example
 * ```ts
 * type T = UnitsOf<"Temperature">
 * // => "degreeCelsius" | "degreeFahrenheit" | "kelvin"
 * ```
 */
export type UnitsOf<Q extends QuantitativeTypeId> = keyof (typeof quantitativeTypes)[Q]["units"]

/** Union of every unit id across all quantitative types. */
export type UnitId = {
  [Q in QuantitativeTypeId]: UnitsOf<Q>
}[QuantitativeTypeId]
