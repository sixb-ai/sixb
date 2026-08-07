import type {
  AlarmRow,
  BusinessState,
  ControlsState,
  EquipmentRow,
  FieldServiceState,
  ReadingRow,
} from "../sources/contracts"
import { createScenarioClock, type ScenarioClock } from "./scenario-clock"

export interface NorthlineScenario {
  readonly business: BusinessState
  readonly fieldService: FieldServiceState
  readonly controls: ControlsState
}

export function createNorthlineScenario(
  clock: ScenarioClock = createScenarioClock()
): NorthlineScenario {
  const updatedAt = clock.minutesAgo(8)

  const business: BusinessState = {
    schemaVersion: 1,
    idempotency: {},
    quoteChanges: [],
    customers: [
      customer(
        "customer-harbor-foods",
        "Harbor Foods Group",
        "strategic",
        "Maya Ortiz",
        "maya.ortiz@harborfoods.example",
        updatedAt
      ),
      customer(
        "customer-keystone-medical",
        "Keystone Medical Partners",
        "priority",
        "David Shah",
        "david.shah@keystonemedical.example",
        updatedAt
      ),
      customer(
        "customer-broad-street",
        "Broad Street Property Group",
        "priority",
        "Amelia Brooks",
        "amelia.brooks@broadstreet.example",
        updatedAt
      ),
      customer(
        "customer-camden-cold",
        "Camden Cold Storage",
        "strategic",
        "Owen Reed",
        "owen.reed@camdencold.example",
        updatedAt
      ),
      customer(
        "customer-delaware-schools",
        "Delaware County Schools",
        "standard",
        "Lena Ward",
        "lena.ward@dcs.example",
        updatedAt
      ),
    ],
    facilities: [
      facility(
        "facility-harbor-newark-dc",
        "customer-harbor-foods",
        "Newark Distribution Center",
        "1200 Logistics Way",
        "Newark",
        "NJ",
        "07114",
        "north_jersey",
        "critical",
        "Loading-dock security has the mechanical-room key. Check in at receiving.",
        updatedAt
      ),
      facility(
        "facility-keystone-riverside",
        "customer-keystone-medical",
        "Riverside Outpatient Center",
        "410 River Road",
        "Philadelphia",
        "PA",
        "19128",
        "philadelphia",
        "critical",
        "Call facilities five minutes before arrival. Patient entrance is restricted.",
        updatedAt
      ),
      facility(
        "facility-broad-market",
        "customer-broad-street",
        "Market Street Offices",
        "1701 Market Street",
        "Philadelphia",
        "PA",
        "19103",
        "philadelphia",
        "important",
        "Freight elevator access is through the 18th Street loading bay.",
        updatedAt
      ),
      facility(
        "facility-camden-freezer",
        "customer-camden-cold",
        "Camden Freezer Campus",
        "88 Ferry Avenue",
        "Camden",
        "NJ",
        "08104",
        "south_jersey",
        "critical",
        "PPE is required beyond the security vestibule.",
        updatedAt
      ),
      facility(
        "facility-delaware-hs",
        "customer-delaware-schools",
        "North County High School",
        "225 Concord Road",
        "Wilmington",
        "DE",
        "19803",
        "delmarva",
        "important",
        "Facilities office opens at 06:30 on school days.",
        updatedAt
      ),
      facility(
        "facility-harbor-allentown",
        "customer-harbor-foods",
        "Allentown Fulfillment Center",
        "700 Commerce Drive",
        "Allentown",
        "PA",
        "18109",
        "philadelphia",
        "important",
        "Use the contractor entrance on the east side.",
        updatedAt
      ),
    ],
    contracts: [
      contract(
        "contract-harbor-priority-care",
        "NLM-24018",
        "customer-harbor-foods",
        "facility-harbor-newark-dc",
        "PriorityCare 24/7",
        "priority_care",
        "24_7",
        90,
        480,
        true,
        true,
        2500,
        clock,
        updatedAt
      ),
      contract(
        "contract-keystone-full-service",
        "NLM-23109",
        "customer-keystone-medical",
        "facility-keystone-riverside",
        "Clinical Full Service",
        "full_service",
        "24_7",
        60,
        360,
        true,
        false,
        5000,
        clock,
        updatedAt
      ),
      contract(
        "contract-broad-preventive",
        "NLM-24044",
        "customer-broad-street",
        "facility-broad-market",
        "PlannedCare Plus",
        "preventive",
        "business_hours",
        240,
        1440,
        true,
        true,
        1000,
        clock,
        updatedAt
      ),
      contract(
        "contract-camden-priority",
        "NLM-23077",
        "customer-camden-cold",
        "facility-camden-freezer",
        "Cold Chain Priority",
        "priority_care",
        "24_7",
        45,
        240,
        true,
        true,
        1500,
        clock,
        updatedAt
      ),
      contract(
        "contract-delaware-preventive",
        "NLM-24061",
        "customer-delaware-schools",
        "facility-delaware-hs",
        "Schools Planned Maintenance",
        "preventive",
        "business_hours",
        360,
        2880,
        true,
        true,
        750,
        clock,
        updatedAt
      ),
    ],
    quotes: [
      {
        quote_id: "quote-q-879",
        quote_number: "Q-879",
        customer_id: "customer-broad-street",
        facility_id: "facility-broad-market",
        service_case_id: "case-sc-1040",
        scope: "Replace AHU-3 actuator and recommission the outside-air sequence.",
        reason: "Actuator replacement is outside planned-maintenance parts coverage.",
        amount: 1840,
        currency: "USD",
        status: "sent",
        valid_until: clock.dateDaysFromNow(21),
        updated_at: clock.hoursAgo(5),
      },
      {
        quote_id: "quote-q-881",
        quote_number: "Q-881",
        customer_id: "customer-camden-cold",
        facility_id: "facility-camden-freezer",
        service_case_id: "case-sc-1041",
        originating_visit_id: "visit-1041",
        scope: "Replace failed condenser-fan motor and verify refrigeration head pressure.",
        reason: "Major components require customer authorization.",
        amount: 3260,
        currency: "USD",
        status: "internal_review",
        valid_until: clock.dateDaysFromNow(14),
        updated_at: clock.minutesAgo(42),
      },
      {
        quote_id: "quote-q-872",
        quote_number: "Q-872",
        customer_id: "customer-delaware-schools",
        facility_id: "facility-delaware-hs",
        scope: "Replace the controller network power supply.",
        reason: "Replacement electronics are excluded from preventive coverage.",
        amount: 980,
        currency: "USD",
        status: "approved",
        valid_until: clock.dateDaysFromNow(7),
        decision_at: clock.daysAgo(1),
        updated_at: clock.daysAgo(1),
      },
    ],
  }
  business.quoteChanges = business.quotes.map(
    (row) => ({ kind: "upsert", row: structuredClone(row) }) as const
  )

  const equipment = createEquipment(clock)
  const fieldService: FieldServiceState = {
    schemaVersion: 1,
    idempotency: {},
    technicians: [
      technician(
        "technician-elena-park",
        "Elena Park",
        "elena.park@northline.example",
        "215-555-0141",
        "north_jersey",
        "rooftop_unit",
        "available",
        updatedAt
      ),
      technician(
        "technician-marcus-reed",
        "Marcus Reed",
        "marcus.reed@northline.example",
        "215-555-0188",
        "philadelphia",
        "boiler",
        "assigned",
        updatedAt
      ),
      technician(
        "technician-priya-nair",
        "Priya Nair",
        "priya.nair@northline.example",
        "267-555-0120",
        "philadelphia",
        "controls",
        "assigned",
        updatedAt
      ),
      technician(
        "technician-luis-mendoza",
        "Luis Mendoza",
        "luis.mendoza@northline.example",
        "856-555-0192",
        "south_jersey",
        "commercial_hvac",
        "available",
        updatedAt
      ),
      technician(
        "technician-jordan-bell",
        "Jordan Bell",
        "jordan.bell@northline.example",
        "302-555-0117",
        "delmarva",
        "controls",
        "available",
        updatedAt
      ),
      technician(
        "technician-samira-khan",
        "Samira Khan",
        "samira.khan@northline.example",
        "610-555-0170",
        "philadelphia",
        "chiller",
        "off_duty",
        updatedAt
      ),
      technician(
        "technician-noah-price",
        "Noah Price",
        "noah.price@northline.example",
        "609-555-0134",
        "south_jersey",
        "rooftop_unit",
        "available",
        updatedAt
      ),
    ],
    workOrders: [
      workOrder(
        "work-order-1038",
        "WO-1038",
        "case-sc-1038",
        "equipment-keystone-boiler-2",
        "technician-marcus-reed",
        "Investigate Boiler 2 flame-safeguard lockout",
        "emergency",
        "on_site",
        clock.hoursAgo(2),
        clock.minutesFromNow(30),
        clock.hoursAgo(2),
        updatedAt
      ),
      workOrder(
        "work-order-1040",
        "WO-1040",
        "case-sc-1040",
        "equipment-broad-ahu-3",
        "technician-priya-nair",
        "Diagnose AHU-3 outside-air control fault",
        "urgent",
        "dispatched",
        clock.minutesFromNow(25),
        clock.hoursFromNow(2),
        clock.minutesAgo(20),
        updatedAt
      ),
      workOrder(
        "work-order-1041",
        "WO-1041",
        "case-sc-1041",
        "equipment-camden-rtu-2",
        "technician-luis-mendoza",
        "Diagnose RTU-2 condenser-fan failure",
        "emergency",
        "paused",
        clock.hoursAgo(4),
        clock.hoursAgo(2),
        clock.hoursAgo(5),
        updatedAt
      ),
      workOrder(
        "work-order-1035",
        "WO-1035",
        "case-sc-1035",
        "equipment-delaware-controller-1",
        "technician-jordan-bell",
        "Restore controller network communication",
        "routine",
        "completed",
        clock.daysAgo(1),
        clock.daysAgo(1),
        clock.daysAgo(1),
        clock.daysAgo(1),
        clock.daysAgo(1)
      ),
    ],
    visits: [
      {
        visit_id: "visit-1038",
        visit_number: "V-1038-1",
        work_order_id: "work-order-1038",
        technician_id: "technician-marcus-reed",
        status: "in_progress",
        scheduled_start: clock.hoursAgo(2),
        started_at: clock.hoursAgo(1.5),
        updated_at: clock.minutesAgo(12),
      },
      {
        visit_id: "visit-1041",
        visit_number: "V-1041-1",
        work_order_id: "work-order-1041",
        technician_id: "technician-luis-mendoza",
        status: "completed",
        scheduled_start: clock.hoursAgo(4),
        started_at: clock.hoursAgo(3.8),
        completed_at: clock.hoursAgo(2.2),
        work_performed:
          "Isolated failed condenser-fan motor and documented replacement requirements.",
        diagnosis_disposition: "quote_required",
        completion_disposition: "follow_up_required",
        updated_at: clock.hoursAgo(2.2),
      },
      {
        visit_id: "visit-1035",
        visit_number: "V-1035-1",
        work_order_id: "work-order-1035",
        technician_id: "technician-jordan-bell",
        status: "completed",
        scheduled_start: clock.daysAgo(1),
        started_at: clock.daysAgo(1),
        completed_at: clock.daysAgo(1),
        work_performed: "Replaced controller network power supply and verified communication.",
        diagnosis_disposition: "resolved_on_site",
        completion_disposition: "resolved",
        updated_at: clock.daysAgo(1),
      },
    ],
    fieldNotes: [
      fieldNote(
        "field-note-1038-1",
        "visit-1038",
        "equipment-keystone-boiler-2",
        "technician-marcus-reed",
        "diagnostic",
        "Flame safeguard shows an intermittent proving-circuit fault. Checking pressure switch tubing and contacts.",
        clock.minutesAgo(28)
      ),
      fieldNote(
        "field-note-1041-1",
        "visit-1041",
        "equipment-camden-rtu-2",
        "technician-luis-mendoza",
        "diagnostic",
        "Condenser-fan motor has failed electrically. Compressor circuit is locked out to prevent high head pressure.",
        clock.hoursAgo(2.7)
      ),
      fieldNote(
        "field-note-1041-2",
        "visit-1041",
        "equipment-camden-rtu-2",
        "technician-luis-mendoza",
        "repair_recommendation",
        "Replace the fan motor and capacitor, then verify amp draw and refrigeration pressures.",
        clock.hoursAgo(2.4)
      ),
      fieldNote(
        "field-note-1035-1",
        "visit-1035",
        "equipment-delaware-controller-1",
        "technician-jordan-bell",
        "general",
        "All downstream controllers remained online for thirty minutes after repair.",
        clock.daysAgo(1)
      ),
    ],
  }

  const controls: ControlsState = {
    schemaVersion: 1,
    idempotency: {},
    equipment,
    readings: createReadings(equipment, clock),
    alarms: createAlarms(clock),
  }

  return { business, fieldService, controls }
}

function customer(
  customer_id: string,
  account_name: string,
  service_tier: "standard" | "priority" | "strategic",
  primary_contact_name: string,
  primary_contact_email: string,
  updated_at: string
) {
  return {
    customer_id,
    account_name,
    service_tier,
    status: "active" as const,
    primary_contact_name,
    primary_contact_email,
    updated_at,
  }
}

function facility(
  facility_id: string,
  customer_id: string,
  facility_name: string,
  address_line: string,
  city: string,
  state: string,
  postal_code: string,
  territory: "philadelphia" | "north_jersey" | "south_jersey" | "delmarva",
  criticality: "standard" | "important" | "critical",
  access_notes: string,
  updated_at: string
) {
  return {
    facility_id,
    customer_id,
    facility_name,
    address_line,
    city,
    state,
    postal_code,
    territory,
    timezone: "America/New_York",
    access_notes,
    criticality,
    status: "operational" as const,
    updated_at,
  }
}

function contract(
  contract_id: string,
  contract_number: string,
  customer_id: string,
  facility_id: string,
  contract_name: string,
  contract_type: "preventive" | "priority_care" | "full_service",
  coverage_hours: "business_hours" | "24_7",
  response_target_minutes: number,
  resolution_target_minutes: number,
  included_labor: boolean,
  major_components_excluded: boolean,
  approval_threshold: number,
  clock: ScenarioClock,
  updated_at: string
) {
  return {
    contract_id,
    contract_number,
    customer_id,
    facility_id,
    contract_name,
    contract_type,
    status: "active" as const,
    starts_on: clock.dateDaysAgo(180),
    ends_on: clock.dateDaysFromNow(185),
    coverage_hours,
    response_target_minutes,
    resolution_target_minutes,
    included_labor,
    major_components_excluded,
    approval_threshold,
    updated_at,
  }
}

function technician(
  technician_id: string,
  full_name: string,
  email: string,
  phone: string,
  territory: "philadelphia" | "north_jersey" | "south_jersey" | "delmarva",
  certification: "commercial_hvac" | "rooftop_unit" | "chiller" | "boiler" | "controls",
  availability: "available" | "assigned" | "off_duty",
  updated_at: string
) {
  return {
    technician_id,
    full_name,
    email,
    phone,
    territory,
    certification,
    availability,
    updated_at,
  }
}

function workOrder(
  work_order_id: string,
  work_order_number: string,
  service_case_id: string,
  equipment_id: string,
  technician_id: string,
  title: string,
  priority: "routine" | "urgent" | "emergency",
  status: "on_site" | "dispatched" | "paused" | "completed",
  scheduled_start: string,
  scheduled_end: string,
  dispatched_at: string,
  updated_at: string,
  completed_at?: string
) {
  return {
    work_order_id,
    work_order_number,
    service_case_id,
    equipment_id,
    technician_id,
    title,
    priority,
    status,
    scope: title,
    scheduled_start,
    scheduled_end,
    dispatched_at,
    completed_at,
    updated_at,
  }
}

function fieldNote(
  note_id: string,
  visit_id: string,
  equipment_id: string,
  technician_id: string,
  note_type: "general" | "diagnostic" | "repair_recommendation",
  body: string,
  recorded_at: string
) {
  return {
    note_id,
    visit_id,
    equipment_id,
    technician_id,
    note_type,
    body,
    recorded_at,
    updated_at: recorded_at,
  }
}

function createEquipment(clock: ScenarioClock): EquipmentRow[] {
  const updated_at = clock.minutesAgo(6)
  const last_seen_at = clock.minutesAgo(2)
  return [
    equipment(
      "equipment-harbor-newark-rtu-7",
      "facility-harbor-newark-dc",
      "RTU-7",
      "rooftop_unit",
      "Trane",
      "Precedent YSC120",
      "NLM-RTU7-1842",
      "critical",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-harbor-newark-rtu-3",
      "facility-harbor-newark-dc",
      "RTU-3",
      "rooftop_unit",
      "Carrier",
      "WeatherMaster 48A",
      "NLM-RTU3-9110",
      "important",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-keystone-boiler-2",
      "facility-keystone-riverside",
      "Boiler 2",
      "boiler",
      "Lochinvar",
      "Crest FBN1500",
      "NLM-BLR2-3881",
      "critical",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-keystone-ahu-1",
      "facility-keystone-riverside",
      "AHU-1",
      "air_handler",
      "Daikin",
      "Vision CAH",
      "NLM-AHU1-7712",
      "important",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-broad-ahu-3",
      "facility-broad-market",
      "AHU-3",
      "air_handler",
      "Johnson Controls",
      "YMA Custom",
      "NLM-AHU3-6234",
      "important",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-broad-chiller-1",
      "facility-broad-market",
      "Chiller 1",
      "chiller",
      "York",
      "YVAA",
      "NLM-CH1-4480",
      "critical",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-camden-rtu-2",
      "facility-camden-freezer",
      "RTU-2",
      "rooftop_unit",
      "Lennox",
      "Energence L",
      "NLM-RTU2-5571",
      "critical",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-delaware-controller-1",
      "facility-delaware-hs",
      "Building Controller",
      "controller",
      "Distech",
      "EC-BOS-8",
      "NLM-CTRL-8204",
      "important",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-delaware-heat-pump-4",
      "facility-delaware-hs",
      "Heat Pump 4",
      "heat_pump",
      "Mitsubishi",
      "CITY MULTI",
      "NLM-HP4-2901",
      "standard",
      last_seen_at,
      updated_at
    ),
    equipment(
      "equipment-harbor-allentown-rtu-1",
      "facility-harbor-allentown",
      "RTU-1",
      "rooftop_unit",
      "Trane",
      "Voyager 3",
      "NLM-RTU1-1066",
      "important",
      last_seen_at,
      updated_at
    ),
  ]
}

function equipment(
  equipment_id: string,
  facility_id: string,
  display_name: string,
  equipment_type: EquipmentRow["equipment_type"],
  manufacturer: string,
  model: string,
  serial_number: string,
  criticality: EquipmentRow["criticality"],
  last_seen_at: string,
  updated_at: string
): EquipmentRow {
  return {
    equipment_id,
    facility_id,
    display_name,
    equipment_type,
    manufacturer,
    model,
    serial_number,
    installed_on: "2019-06-15",
    criticality,
    last_seen_at,
    updated_at,
  }
}

function createReadings(
  equipmentRows: readonly EquipmentRow[],
  clock: ScenarioClock
): ReadingRow[] {
  return equipmentRows.flatMap((row, equipmentIndex) =>
    [45, 30, 15, 2].map((minutesAgo, sampleIndex) => {
      const golden = row.equipment_id === "equipment-harbor-newark-rtu-7"
      const unhealthy = golden || row.equipment_id === "equipment-camden-rtu-2"
      const supply = unhealthy
        ? 69 + sampleIndex * 1.7
        : 54 + (equipmentIndex % 3) + sampleIndex * 0.2
      const current = unhealthy
        ? 25 + sampleIndex * 2.2
        : 10 + (equipmentIndex % 4) + sampleIndex * 0.3
      return {
        reading_id: `${row.equipment_id}-reading-${sampleIndex + 1}`,
        equipment_id: row.equipment_id,
        recorded_at: clock.minutesAgo(minutesAgo),
        supply_temp: supply,
        return_temp: unhealthy ? 78 : 72 + (equipmentIndex % 2),
        temperature_unit: "degreeFahrenheit" as const,
        compressor_current: current,
        current_unit: "ampere" as const,
      }
    })
  )
}

function createAlarms(clock: ScenarioClock): AlarmRow[] {
  return [
    alarm(
      "alarm-harbor-rtu-7-vfd",
      "equipment-harbor-newark-rtu-7",
      "RTU-7 cannot maintain supply temperature; compressor current is elevated.",
      "high",
      "equipment",
      "active",
      clock.minutesAgo(18),
      clock.minutesAgo(4)
    ),
    alarm(
      "alarm-keystone-boiler-lockout",
      "equipment-keystone-boiler-2",
      "Boiler 2 entered flame-safeguard lockout.",
      "critical",
      "safety",
      "acknowledged",
      clock.hoursAgo(3),
      clock.minutesAgo(12),
      clock.hoursAgo(2.8)
    ),
    alarm(
      "alarm-broad-ahu-damper",
      "equipment-broad-ahu-3",
      "AHU-3 outside-air damper failed to track command.",
      "medium",
      "comfort",
      "acknowledged",
      clock.hoursAgo(6),
      clock.minutesAgo(20),
      clock.hoursAgo(5.8)
    ),
    alarm(
      "alarm-camden-condenser-fan",
      "equipment-camden-rtu-2",
      "RTU-2 condenser-fan proof is lost.",
      "critical",
      "equipment",
      "acknowledged",
      clock.hoursAgo(7),
      clock.hoursAgo(2),
      clock.hoursAgo(6.8)
    ),
    alarm(
      "alarm-delaware-controller-offline",
      "equipment-delaware-controller-1",
      "Building controller stopped communicating.",
      "medium",
      "communication",
      "cleared",
      clock.daysAgo(1),
      clock.daysAgo(1),
      clock.daysAgo(1),
      clock.daysAgo(1)
    ),
  ]
}

function alarm(
  alarm_id: string,
  equipment_id: string,
  message: string,
  severity: AlarmRow["severity"],
  category: AlarmRow["category"],
  status: AlarmRow["status"],
  observed_at: string,
  updated_at: string,
  acknowledged_at?: string,
  cleared_at?: string
): AlarmRow {
  return {
    alarm_id,
    equipment_id,
    message,
    severity,
    category,
    status,
    observed_at,
    acknowledged_at,
    cleared_at,
    updated_at,
  }
}
