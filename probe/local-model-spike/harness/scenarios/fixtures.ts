/**
 * Built fixtures for the chat-tier measurement: three short documents that are
 * inlined into the prompt, one just under the inline threshold, and two long
 * ones the model can only read through `get_outline` / `read_section`.
 *
 * Every fact a scenario asks for sits beside a planted near-miss (last
 * period's figure, the draft date, a superseded target, a second person with a
 * similar role). A few sentences are deliberately flawed (subject-verb
 * disagreement, wordiness, a sum that does not add up) so that the
 * editing-request scenarios have something real to fix. No flaw changes a
 * figure an answerable scenario asks for; two flawed figures (a mis-stated
 * overrun and a mis-stated percentage) are used only as planted values that
 * an unanswerable scenario's reply must not offer.
 *
 * `shape` is each fixture's claim about itself, checked against the extracted
 * text by a test.
 */
import type { Fixture } from "./types.js";

/** `[heading, paragraph, paragraph, ...]` */
type Section = [string, ...string[]];

function buildDocument(title: string, lead: string, sections: Section[]): string {
  const parts = [`# ${title}`, lead];
  for (const [heading, ...paragraphs] of sections) {
    parts.push(`## ${heading}`, ...paragraphs);
  }
  return `${parts.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Short, inlined
// ---------------------------------------------------------------------------

const OPS_REVIEW = `# Harlow Freight Services: Third Quarter 2026 Operations Review

Prepared by Dana Whitcombe, director of operations. A draft was circulated on October 6, 2026, and the operating committee approved this final version on October 14, 2026.

## Summary

Revenue for the third quarter was $4.82 million, up from $4.41 million in the second quarter. On-time delivery reached 93.4%, compared with 91.2% in the second quarter. The on-time target for the year was originally 95%, but the committee lowered it to 94% on July 20 after the Dayton warehouse flood.

## Volume and staffing

The network handled 61,300 shipments in the quarter, against 57,900 in the second quarter. Headcount stood at 212 at the end of September, including 17 drivers hired during the quarter. The team of dispatchers in Columbus were reorganized into two shifts in August. Overtime hours fell 12% from the second quarter, which Whitcombe attributes to the new second shift.

## Costs

Fuel cost averaged 68 cents per mile, down from 74 cents in the third quarter of 2025. Maintenance spending was $310,000, which was $45,000 over the budget of $275,000. The overrun is due to the fact that two refrigerated trailers needed to have their compressors replaced earlier than had been planned for in the maintenance schedule.

## Customers

The claims rate was 0.8% of shipments, against 1.1% in the second quarter. Our largest customer, Brightwater Grocers, renewed its contract for three years on September 22, 2026. A second customer, Calloway Home Goods, gave notice that it will not renew when its contract ends on December 31, 2026. Customer service is led by Priya Raman, and claims are handled by Marcus Oyelaran, the claims manager.

## Risks

Three risks need the committee's attention:

- Driver turnover is running at 23% on an annualized basis.
- The lease on the Dayton warehouse expires in March 2027, and the landlord has not yet offered a renewal.
- The vendor of our routing software will end support for the current version in June 2027.

## Priorities for the fourth quarter

We plan to hire 10 more drivers before the holiday peak. The Louisville cross-dock, which was first scheduled to open on October 20, 2026, is now expected to open on November 17, 2026. We will also begin talks with the Dayton landlord and ask two other routing vendors for quotes before the end of the year.
`;

const CLINIC_HANDBOOK = `# Marlowe Street Family Clinic: Staff Handbook Excerpt

This excerpt covers scheduling, leave, patient records and training. It was revised on August 3, 2026 and takes effect on September 1, 2026, when it replaces the 2024 edition.

## Scheduling

Schedules are posted 14 days in advance. Under the 2024 edition they were posted 7 days in advance. Shift swaps must be approved by the clinic manager, Helen Abara, at least 48 hours before the shift begins. The nursing supervisor, Tomas Reyes, may approve a swap between two nurses on a weekend when the manager is not on site. Staff who are late more than three times in a month will meet the manager to agree a plan.

## Leave

Full-time staff accrue 18 days of paid leave a year, up from 15 days under the 2024 edition. Part-time staff accrue leave in proportion to their hours. The leave year ends on December 31. Up to 5 unused days may be carried into the next year, and any days beyond that are forfeited on January 31. Requests for leave of more than three consecutive days must be submitted at least 30 days ahead. Sick leave is separate: 8 days a year, with a doctor's note required from the fourth consecutive day.

## Patient records

Each of the front-desk staff are responsible for locking their workstation when they step away from it. Paper records must be returned to the records room by the end of each shift. A patient's request for a copy of their records must be answered within 10 business days, although the legal limit is 30 calendar days. Staff may not send patient information by personal email under any circumstances. The privacy officer is Dr. Lena Okafor. Questions about the records system itself go to the office administrator, Samuel Pike.

## Training

Every employee completes privacy training within 30 days of being hired and again every 12 months. In the event that an employee has not completed the training at the point in time when it falls due, their records access will be suspended until such time as it has been completed. Last year 41 of 46 employees completed the training on time, a rate of 92%. The clinic pays for CPR certification, which is renewed every 2 years, up to a limit of $85 per person.

## Incidents

A needle-stick injury or other exposure must be reported to a supervisor within 1 hour and in writing within 24 hours. Incident reports are reviewed each month by the safety committee, which is chaired by Ruth Calder. Nobody will be disciplined for reporting an incident in good faith.
`;

const LEASE_SUMMARY = `# Lease Summary: Unit 4, 220 Kestrel Road

Prepared for the board of Northgate Print Cooperative by Irene Vasquez, treasurer. This summary was drafted on February 9, 2026. The lease was signed on January 22, 2026, and the term begins on March 1, 2026.

## Parties and premises

The landlord is Kestrel Road Holdings LLC, which is represented by its property manager, Gordon Liddell. The tenant is Northgate Print Cooperative. The premises are 6,400 square feet of ground-floor workshop space with 8 parking spaces. The cooperative's previous unit at the same address was 4,900 square feet.

## Term and rent

The term is 5 years, ending on February 28, 2031, with one option to renew for a further 3 years. Base rent is $9,600 a month in the first year, compared with $7,350 a month for the previous unit. Rent rises by 3% on each anniversary. Rent is due on the first of each month, and a late fee of 5% applies after the tenth. The security deposit is $19,200, equal to two months of base rent.

## Operating costs

The tenant pays a 22% share of the building's operating costs, estimated at $1,450 a month for 2026. The estimate is reconciled against actual costs each April. The landlord insures the building. The tenant insures its own equipment and must carry liability cover of at least $2 million.

## Improvements

The landlord will contribute $40,000 toward the fit-out. The cooperative expects the work to cost $65,000 in total, leaving $20,000 to be paid from reserves. Work must be finished by May 15, 2026. The landlord's approval are required for any structural change. Two contractors have quoted: Alder Build at $63,500 and Penrose Interiors at $68,200.

## Leaving the premises

The tenant may end the lease early at any time after the third year by giving 9 months of written notice and paying a fee equal to 4 months of base rent. Notice of an intention to renew must be given at least 12 months before the term ends. It should be noted that, at the end of the term, the tenant is under an obligation to return the premises to the landlord in the same condition in which they were at the start of the term, with the exception of ordinary wear and tear.

## Questions for the board

- whether to buy flood cover, since the unit is close to the river
- which contractor to appoint for the fit-out
- who will hold the keys and the alarm codes
`;

// ---------------------------------------------------------------------------
// Just under the inline threshold
// ---------------------------------------------------------------------------

const GRANT_REPORT = `# Riverbend Literacy Partnership: Year Two Report to the Ashdown Community Foundation

Submitted by Miriam Castellanos, executive director. This report covers the second grant year, from July 1, 2025 to June 30, 2026. A first draft was shared with the foundation's programme officer on June 18, 2026, and this final version was submitted on July 24, 2026.

## Overview

The partnership provides free reading tuition to adults in the Riverbend valley through trained volunteer tutors. The foundation's grant for year two was $180,000, an increase on the $150,000 awarded in year one. With it we enrolled more learners, opened new sites and, for the first time, paid for an independent evaluation. This report describes what was delivered, what the evaluation found, how the money was spent and what we propose for year three.

## Learners

We enrolled 342 learners in year two, against a target of 320 and compared with 268 in year one. Just over half were referred by employers or job centres; the rest came through libraries, word of mouth and our family reading nights. The number of learners who has completed the full programme rose to 187. Learners at the rural sites were, on average, older than those in town and more likely to have left school before the age of sixteen.

## Sites

Tuition was offered at 14 sites, up from 9 in year one. The new sites are in libraries and community halls in the upper valley, where no adult literacy provision existed before. Each site has a volunteer site lead who keeps the register and is the first point of contact for learners. Two of the new sites share a lead, which has worked less well than we hoped, and we intend to recruit a second person.

## Tutoring

Each learner is matched with a tutor and meets them once a week for ninety minutes. Average attendance across the year was 81%. Tutors follow a structured programme but are encouraged to bring in material that matters to the learner, such as a driving theory handbook or letters from a child's school. In view of the fact that a considerable number of our learners work changing shifts, we made the decision to offer evening and Saturday morning sessions at every site.

## Family reading nights

We held 11 family reading nights during the year, with a total attendance of 1,430, an average of 150 people at each event. These evenings bring parents and children together around books and are our most effective way of reaching adults who would not otherwise ask for help. Local authors read at four of them, and the library service lent every family a bag of books to take home.

## Volunteers

The programme depends on its volunteers. We ended the year with 96 active tutors, compared with 71 a year earlier. Every new tutor completes six hours of training before meeting a learner and is observed once in the first term. Volunteers gave more than 9,000 hours during the year. Retention is good: most tutors who complete a first year stay for a second, and several former learners have now trained as tutors themselves.

## Support for tutors

Tutors told us last year that they felt alone once their initial training was over. In response we set up a tutor forum at each site every term, where tutors compare notes and raise problems with the site lead. We also began sending a short monthly bulletin with teaching ideas and news from other sites. Tutors who work with learners at the lowest reading level can now ask for a visit from a specialist teacher, and about a third of them did so during the year. The feedback on all three changes has been warm, although tutors in the upper valley would like the forums to meet closer to home.

## Partners

We work with six public libraries, the valley's two job centres and a growing number of employers. Halden Foods, the largest employer in the upper valley, now releases staff for one session a week in working time, and eleven of its employees enrolled this year. The library service provides rooms without charge, which we value at more than our entire materials budget. In return we train library staff to recognise and gently refer adults who struggle with reading.

## Outcomes

The evaluation was carried out by Dr. Owen Fairchild of Penmoor University. It found that 64% of learners advanced at least one reading level during the year, compared with 58% in year one. Our original target was 70%; in January 2026 the foundation agreed to revise it to 65%, to reflect the higher share of learners starting at the lowest level. The evaluation also interviewed learners, many of whom spoke about confidence: reading a bedtime story, filling in a form without help, applying for a better job.

## What learners told us

We asked learners what had changed for them. A warehouse worker in his fifties said he had read a safety notice aloud to his team for the first time. A mother of three said she no longer pretends to have forgotten her glasses at parents' evening. Several learners said the weekly session was the only time in the week set aside for themselves. Not everything was positive: some found the pace slow, and a few wanted group classes as well as individual tuition.

## Budget

We spent $171,400 of the $180,000 grant. Staff salaries accounted for $112,000, learning materials for $23,500, transport for learners and volunteers for $14,900, and evaluation for $21,000, a line that covers the evaluator's fee together with assessment materials. The unspent balance of $8,600 results from the coordinator post standing vacant for part of the year. We have asked the foundation for permission to carry this balance forward into year three.

## Staffing

The programme coordinator, Joel Abernathy, left the partnership in February 2026. His successor, Nadia Rahimi, started on April 6, 2026. In the weeks between, the executive director covered the coordinator's duties and some planned work, including a tutor conference, was postponed. The partnership now employs three people, two of them part time.

## Governance

The partnership is overseen by a board of nine trustees, which met five times during the year. The board's finance committee reviews spending against the grant every quarter. Two former learners joined the board in the autumn, and their presence has changed the tone of its discussions for the better. The annual accounts are examined independently, and a copy will be sent to the foundation when they are approved.

## Challenges

Recruitment in the rural sites was slower than in town, and two of the new sites did not reach ten learners until the spring. Transport remains the main barrier: several learners depend on a single daily bus. The vacancy in the coordinator post delayed the tutor conference and put pressure on a small team. Finally, the assessment used by the evaluation takes almost an hour, and some learners found it discouraging at the start of their course.

## Plans for year three

In year three we plan to open 3 further sites, bringing the total to 17, and to enrol 380 learners. We will pilot a shorter assessment with the evaluator. We will hold the postponed tutor conference in the autumn. We will also recruit a part-time volunteer manager, so that the coordinator can spend more time with site leads and less on rotas and paperwork.

## Request to the foundation

We request a grant of $195,000 for year three. The increase would fund the volunteer manager post and transport for learners at the new sites. An interim report would be submitted by January 29, 2027 and a final report by July 30, 2027. We are grateful for the foundation's support and would welcome a visit from trustees to any of our sites.
`;

// ---------------------------------------------------------------------------
// Deep: read through get_outline / read_section
// ---------------------------------------------------------------------------

const FIELD_STUDY = buildDocument(
  "Cross-Bay Ferry Rider Study: Findings from the Autumn 2025 Fieldwork",
  "Prepared by the research team of the Tidewater Transit Authority for the planning committee and the board.",
  [
    [
      "Purpose of the study",
      "The Tidewater Transit Authority asked its research team to find out how commuters use the cross-bay ferry and what stops more people from choosing it. The authority has ridership counts from its ticket gates, but counts say nothing about why a rider chose the boat, how they reached the dock, or what nearly made them give up. This study fills that gap with interviews, observation and a short survey. It is meant to inform decisions the board will take in early 2026 about terminals, timetables and fares.",
    ],
    [
      "Who commissioned the work",
      "The study was commissioned by the authority's planning committee after a public meeting in the spring at which riders complained about crowding on the docks. The committee wanted evidence gathered by staff, not by a consultant, partly to build skills inside the organisation and partly so that the people who run the service would hear riders directly. The research team reports to the director of planning, and this document is the team's full account of what it did and found.",
    ],
    [
      "Research questions",
      "Three questions shaped the work. First, how do riders travel to and from the terminals, and where does that journey break down? Second, what do riders value about the ferry compared with driving or taking the bus over the bridge? Third, which problems would riders most like fixed, and which would they tolerate? The team agreed at the outset not to study fares in depth, because a separate fare review is under way, although riders were free to raise the subject.",
    ],
    [
      "Fieldwork calendar",
      "Fieldwork ran through the autumn of 2025. The first fortnight was spent piloting the interview guide and training the observers. The main period of interviewing and observation followed, covering ordinary working weeks and avoiding school holidays, when travel patterns are unusual. A final week was held back for return visits to the terminals where early notes were thin. Analysis began while fieldwork was still in progress, so that later interviews could probe themes that came up early.",
    ],
    [
      "Choice of terminals",
      "The service calls at three terminals: Harbour Point on the north shore, Carrow Quay in the city centre, and Ferris Landing on the south shore. All three were included. Harbour Point carries the most morning commuters and has the largest catchment of people who drive to the dock. Carrow Quay is where most riders finish their morning journey and begin their evening one. Ferris Landing is the smallest and newest terminal, and was included to see whether a quieter dock produces a different experience.",
    ],
    [
      "Recruiting riders on the dock",
      "Researchers approached riders in the waiting areas, explained the study and asked for ten minutes. People who were short of time were offered a card with a telephone number and could be interviewed later. No payment was offered, but participants received a voucher for a hot drink from the terminal kiosk. Researchers were asked to approach a mix of people and not only those who looked willing to talk, and to note refusals so that the team could judge who was being missed.",
    ],
    [
      "Interview guide",
      "The guide had four parts: the journey to the terminal, the wait, the crossing, and the onward journey. Each part opened with a broad prompt, such as asking the rider to describe this morning from leaving home, followed by optional probes. Interviewers were told to follow the rider's own account and not to force every probe. The guide was shortened after the pilot, when it became clear that riders lost patience with questions about the crossing itself, which most found uneventful.",
    ],
    [
      "Onboard observation method",
      "Two observers rode selected sailings and kept structured notes on boarding, seating, crowding at the doors and how riders spent the crossing. They did not approach riders during observation, so that behaviour was disturbed as little as possible. Notes were written up the same day. Where the two observers disagreed about what they had seen, both versions were kept and the disagreement was discussed at the weekly team meeting, not settled by whoever was more senior.",
    ],
    [
      "Survey design",
      "A short paper survey was handed out on the dock and collected on board. It asked about the rider's usual journey, how often they travel, and how satisfied they are with several aspects of the service, each scored from zero to ten. The wording of the satisfaction questions was kept identical to the authority's 2023 rider survey so that the two could be compared. An online version was offered through a printed code, but few riders chose it.",
    ],
    [
      "Notes on the sample",
      "The people who took part were not a random sample of riders. Regular commuters are over-represented, because they were on the dock most days and easier to find. Occasional riders, visitors and people travelling outside the peak are under-represented. The team has tried to be careful about this throughout: where a finding rests on a handful of conversations, the text says so, and percentages are reported only for the survey, never for the interviews.",
    ],
    [
      "Data handling and privacy",
      "Interviews were recorded only with permission and the recordings were deleted once notes had been checked. Names were not written on survey forms. Notes are stored on the authority's own systems and are open only to the research team. Quotations in this report have been lightly edited to remove details that could identify a rider, such as an employer's name or an unusual working pattern. Riders were told they could withdraw their contribution at any time.",
    ],
    [
      "Limits of the method",
      "This is a study of people who already ride the ferry. It cannot say much about people who have never tried it, and it should not be read as a forecast of demand. Observation was limited to weekday peak sailings. The weather was mild for most of the fieldwork, so the findings may understate how unpleasant the open docks become in winter. Finally, the researchers are employees of the authority, and some riders may have softened their criticism for that reason.",
    ],
    [
      "Morning boarding patterns",
      "Morning boarding at Harbour Point is orderly but tight. Riders arrive in a steady stream and most reach the dock only a few minutes before departure, which they described as a deliberate habit, not carelessness. The queue forms along the railing and blocks the path to the ticket machines, so that a rider who needs a ticket must push through people who already have one. Staff manage this well on ordinary days, but observers saw it break down whenever a sailing ran late.",
    ],
    [
      "Evening boarding patterns",
      "The evening picture at Carrow Quay is different. Riders arrive earlier and wait longer, because they are less sure when they will get away from work. The waiting area is small for the numbers involved and has few seats. Several riders said the evening wait was the worst part of their day, and one described standing in the wind as the price of a quiet crossing. Boarding itself is slower in the evening because more riders are carrying shopping or bicycles.",
    ],
    [
      "Ticketing behaviour",
      "Most regular commuters hold a monthly pass and never use the ticket machines. Occasional riders rely on the machines and find them slow. Observers noted that the machines offer too many choices on the first screen, and that riders often chose the wrong fare and had to start again. Staff at the gates spend a good part of each peak answering ticket questions. Riders did not ask for cheaper tickets so much as for a quicker way to buy the right one.",
    ],
    [
      "Getting to the terminal",
      "How riders reach the dock varies sharply by terminal. At Carrow Quay nearly everyone walks. At Ferris Landing most are dropped off or cycle. At Harbour Point the majority drive, and their accounts of the journey were dominated by one subject, which is parking. Bus connections to all three terminals exist but were rarely mentioned, and the few riders who use them said the buses are not timed to meet the boats.",
    ],
    [
      "Bus connections",
      "The team rode each connecting bus route at least twice. At Harbour Point the bus stop is a long walk from the dock across an unlit car park, and the timetable leaves riders either rushing or waiting a long time. At Carrow Quay the stops are close but poorly signed. Drivers told observers they are not informed when a ferry is running late and so cannot hold a bus. Riders who had tried the bus once and gone back to driving gave these reasons almost word for word.",
    ],
    [
      "Parking at Harbour Point",
      "The Harbour Point lot has 240 spaces and is free to use. Observers counted cars on 22 weekday mornings and found the lot full before the second sailing on 19 of them. Riders who arrive later park on nearby residential streets, which has led to complaints from residents. By contrast the lot at Carrow Quay, which has 310 spaces, never filled during the study, because few riders begin their journey there. The team did not count spaces at Ferris Landing, where parking is on the street.",
    ],
    [
      "Bicycle storage findings",
      "Cycling to the dock is growing faster than the facilities for it. Harbour Point has 36 rack spaces, and observers counted 58 bicycles there at the morning peak, with the extra ones chained to railings and lamp posts. Riders asked for covered, secure storage more often than for anything else connected with cycling. Two riders said they had stopped cycling after a theft. Taking a bicycle on board is allowed, but riders with bicycles board last and often cannot find space.",
    ],
    [
      "Wayfinding and signage problems",
      "Signage was the most common source of confusion for occasional riders. At Carrow Quay the gate numbers were repainted in 2024, but the overhead signs still show the old numbers, so riders following the signs arrive at the wrong gate. At Harbour Point the sign for the ticket machines points toward a door that is kept locked. Regular commuters no longer notice these faults, which may be why they have gone unreported for so long.",
    ],
    [
      "Accessibility observations",
      "Observers followed the step-free route at each terminal. All three have ramps, but the ramp at Harbour Point becomes steep at low tide and two riders who use wheelchairs said they plan their travel around the tide table. Audio announcements on the docks were hard to hear over engine noise. Staff were consistently praised for offering help without being asked. The team recommends a separate, properly resourced accessibility audit, since this study only touched the subject.",
    ],
    [
      "Rider satisfaction scores",
      "The survey asked riders to score the service from zero to ten. Overall satisfaction averaged 7.4, compared with 6.9 in the authority's 2023 survey. Staff courtesy was the highest-scoring item at 8.6. Information during delays was the lowest at 4.8, and it was also the subject riders raised most often in interviews without being asked. Scores for the crossing itself were high and varied little between terminals.",
    ],
    [
      "Reasons riders gave for switching from driving",
      "The survey asked riders who used to drive across the bridge why they had switched. The cost of parking in the city centre was the most common reason, chosen by 41% of them. Congestion on the bridge came second at 33%. Smaller numbers mentioned the chance to read or rest during the crossing, and a few said a change of workplace had made the ferry practical. Almost nobody gave the environment as their main reason, although several mentioned it as a welcome side effect.",
    ],
    [
      "Cost of the fieldwork",
      "The planning committee approved a budget of $92,000 for the study in June 2025. The fieldwork and analysis cost $86,500 in the end, mostly staff time, with the remainder spent on printing, vouchers and transcription. For comparison, the 2023 rider survey, which was carried out by an outside firm, cost $74,000. Spending was tracked by the finance officer, Rafael Quint, and reported monthly to the study lead, Dr. Imogen Hale.",
    ],
    [
      "Recommendations to the board",
      "The team makes four recommendations. Give riders live information about delays on the docks and by text message. Correct the signs at Carrow Quay and Harbour Point, which is cheap and could be done at once. Install covered, secure bicycle storage at Harbour Point. Finally, do not enlarge the Harbour Point car park: the land beside it is tidal marsh and cannot be built on, and a timed shuttle from the park-and-ride site on Mill Road would serve more riders for less money.",
    ],
    [
      "Proposed pilot schedule",
      "The team proposes to test the shuttle and the delay information together. If the board agrees at its meeting on February 17, 2026, the pilot would begin on March 9, 2026 and run for 12 weeks. Riders would be surveyed in the fourth and the final week using the same questions as this study. A short report on the pilot would follow within a month of its end, in time for the board to decide whether to fund the changes permanently.",
    ],
    [
      "Open questions for the next round",
      "Several matters are left open. The study did not reach people who have never ridden the ferry, and a household survey in the north shore suburbs would be the natural next step. Winter conditions need their own observation. The effect of the fare review on these findings is unknown. And the team would like to return to Ferris Landing, where the small number of interviews makes it hard to say anything with confidence.",
    ],
  ],
);

const RELEASE_PLAN = buildDocument(
  "Ledgerline 6.0 Release Plan",
  "Maintained by the release manager and reviewed at the weekly release meeting.",
  [
    [
      "Purpose of this plan",
      "This plan sets out how Ledgerline 6.0 will be prepared, tested and released to customers. It is written for the people who will do the work and for the managers who must sign it off. It replaces the outline circulated in the autumn and should be treated as the single reference for dates, owners and criteria. Where this plan and an older document disagree, this plan is correct. It will be updated after each weekly release meeting, and changes will be listed at that meeting.",
    ],
    [
      "What the release contains",
      "Version 6.0 is the largest change to the product in several years. It moves every customer's records to a new storage format, replaces the reporting screens, and adds bank feeds for business accounts. It also removes the old desktop export tool, which a small number of long-standing customers still use. Because the storage change cannot be made gradually, all customers will move to the new version within the same window, which is why this release needs more planning than usual.",
    ],
    [
      "Customers affected",
      "Every customer is affected by the storage change, but not equally. Small firms with a single set of books should notice little beyond the new reporting screens. Accountancy practices that manage many client files will see the longest migration times and have the most to lose from a failed one. Customers who rely on the desktop export tool will need an alternative before release day. The account management team has a list of these customers and is contacting each one.",
    ],
    [
      "Planning assumptions",
      "The plan rests on a few assumptions. The engineering team stays at its present size through the release. No other major release is scheduled in the same quarter. The hosting provider completes its own storage upgrade before our migration rehearsals begin. Customers are given at least four weeks of notice of the release date. If any of these assumptions fails, the release manager will bring a revised plan to the weekly meeting; nobody should quietly absorb the change.",
    ],
    [
      "Development milestones",
      "Development is organised in three stages. The storage work comes first, because everything else depends on it. The new reporting screens follow, built against the new storage format from the start. Bank feeds come last and are the only part that could be held back to a later version without disturbing the rest. Each stage ends with a review at which the engineering lead confirms that the work is complete enough for testing to begin in earnest.",
    ],
    [
      "Feature freeze rules",
      "After the feature freeze, no new functions are added to the release. Fixes for defects are allowed, but each one needs the agreement of the engineering lead and the test lead, and must come with a note of what was retested. Changes to wording on screen are treated as fixes. Requests from customers or from sales to add one more small thing are to be recorded for the next version and politely declined, however reasonable they sound at the time.",
    ],
    [
      "Testing approach",
      "Testing combines automated checks, which run on every change, with manual testing of complete tasks such as closing a month or filing a tax return. Manual testing is carried out by the test team and by volunteers from support, who know how customers really use the product. Defects are graded by their effect on the customer, not by how hard they are to fix. A release candidate is declared only when no defect of the two most serious grades remains open.",
    ],
    [
      "Performance testing",
      "The new storage format should make large reports faster, and that claim has to be checked, not assumed. Performance tests use copies of real customer files of different sizes, with identifying details removed. The tests measure how long common tasks take before and after the change. Any task that becomes noticeably slower is treated as a defect. Results are shared with the support team so that they know what to expect when customers call.",
    ],
    [
      "Security review",
      "An independent reviewer examines the bank feeds and the new storage layer before the beta opens. The review looks at how credentials are stored, who inside the company can read customer records, and what is written to logs. Findings are graded, and anything in the top grade must be fixed before release. The reviewer's summary is shared with the leadership team. Details are restricted to the people who need them to do the fixing.",
    ],
    [
      "Accessibility checks",
      "The new reporting screens are checked against the company's accessibility standard by a tester who uses a screen reader every day. Keyboard access, colour contrast and the reading order of tables are checked on every screen. The old reporting screens fell short in several places, and customers noticed. Meeting the standard is a condition of release for the new screens. It is not something to tidy up afterwards.",
    ],
    [
      "Documentation updates",
      "Every help article that mentions reports, exports or storage has to be revised. The documentation team has listed the affected articles and assigned each to a writer. Screenshots are taken from the release candidate, not from earlier builds, so that they match what customers see. Articles for the removed desktop export tool are kept but marked as applying only to older versions. New articles are reviewed by a member of the support team before they are published.",
    ],
    [
      "Translation and localisation",
      "The product is offered in five languages. New and changed text is sent for translation as soon as the feature freeze takes effect, since wording should be stable from that point. Translated screens are checked by a native speaker inside the company for length as well as meaning, because longer phrases can break the layout of buttons and table headings. Date and currency formats are tested separately for each region.",
    ],
    [
      "Training for support staff",
      "Support staff are trained in two sessions. The first covers what has changed and why. The second is practical: each person migrates a test account, runs the new reports and works through the most likely customer questions. A short guide to known problems is kept up to date through the beta and the release. Staff who join the rota from other offices for release week attend the same sessions by video.",
    ],
    [
      "Partner communications",
      "Accountancy partners hear about the release before ordinary customers do, because their own clients will ask them about it. Each partner receives a briefing and a named contact. Partners who build their own tools on top of our exports are given early access to the new export formats and a test account. The partner manager collects their questions and brings the common ones to the weekly release meeting.",
    ],
    [
      "Customer announcements",
      "Customers are told about the release in three steps: an early notice describing what is coming, a detailed notice once the date is firm, and a reminder in the final week. Each notice says plainly that records will be unavailable for a short time during migration and tells customers what, if anything, they need to do beforehand. Notices are sent by email and shown inside the product. The wording is agreed with the support lead.",
    ],
    [
      "Help for customers using the desktop export tool",
      "Customers who still use the desktop export tool need individual attention. Account managers are contacting each of them to explain the replacement and to offer help setting it up. A few have built their month-end routines around the old tool and will need more than an email. Where a customer cannot be ready in time, the account manager records the case and the release manager decides whether any special arrangement is justified.",
    ],
    [
      "Hosting and capacity",
      "The migration places an unusual load on the hosting platform, because every account is rewritten within a short period. The infrastructure team has agreed extra capacity with the hosting provider for release week and the week after. Monitoring has been extended to cover the new storage layer. An engineer from the hosting provider will be on call during the migration window, and the escalation route has been tested with a deliberate false alarm.",
    ],
    [
      "Beta programme",
      "The beta opened on January 11, 2027. The plan called for 60 customers, but only 45 agreed to take part, mainly because the beta overlaps with the busiest weeks of the tax season for accountancy practices. The participants are a fair mix of small firms and practices. Their feedback is collected in a weekly call and through a form inside the product. Defects found by beta customers are graded in the same way as those found by the test team.",
    ],
    [
      "Data migration rehearsals",
      "The migration is rehearsed on copies of real accounts. The first rehearsal was stopped part way through after a storage fault at the hosting provider, and no reliable count of results was kept. The second rehearsal, on February 8, 2027, migrated 1,180 of 1,200 test accounts without error. The remaining accounts all failed for the same reason, an unusual currency setting, which has since been fixed. A third rehearsal will be run in the week before the go or no-go meeting.",
    ],
    [
      "Go or no-go meeting",
      "The go or no-go meeting will be held on March 2, 2027. It is chaired by the release manager, Katrin Olsen, who presents the state of testing, the rehearsal results and the open defects. The engineering, test and support leads each give a recommendation. The final decision rests with the chief product officer, Desmond Achterberg. If the decision is no-go, the meeting sets a new date before it closes, so that customers are not left without one.",
    ],
    [
      "Release day schedule",
      "General release is set for March 16, 2027. It was originally planned for February 23, 2027 and was moved after the first migration rehearsal failed. Migration begins in the early hours, when few customers are working, and proceeds in batches, smallest accounts first. Customers see a notice while their own account is being moved. The release manager posts progress every hour in the release channel until the last batch is complete.",
    ],
    [
      "Rollback criteria",
      "The release will be rolled back if more than 2% of migrations fail in the first four hours, or if any customer's records are found to be altered. An earlier draft of this plan set the threshold at 5%; it was tightened after the support lead pointed out how many calls that would mean. A rollback returns every migrated account to the old format from the backup taken immediately before its migration. The decision to roll back is the release manager's alone.",
    ],
    [
      "Support cover after release",
      "For the two weeks after release, support hours are extended into the evening on weekdays. Weekday cover is led by Bettina Kruger, the support lead, with eight staff on each shift. Weekend cover will be drawn from the Lisbon office, and the names for that rota have not yet been confirmed. Engineers are paired with support staff for the first three days so that a defect reported by a customer reaches someone who can fix it within the hour.",
    ],
    [
      "Pricing changes with this release",
      "Two prices are affected on release day. The Standard plan rises from $29 to $32 per user each month. The Team plan stays at $55. Customers on annual contracts keep their present price until renewal. Prices for the Premium plan are being set separately by the finance team and are not part of this plan. Account managers have been given a short explanation of the increase, which is the first in three years.",
    ],
    [
      "Budget for the release",
      "The release has a budget of $410,000, covering contract testers, the security review, extra hosting capacity, translation and overtime. By the end of January, $268,000 had been spent. The largest remaining item is hosting capacity for release week. The release manager reports spending to the finance team each month and will flag any item likely to run over before the money is committed, not after.",
    ],
    [
      "Known risks",
      "Three risks stand out. A further fault at the hosting provider could interrupt the migration itself. Beta coverage of large accountancy practices is thinner than planned, so problems that appear only at scale may be found late. And the support team could be overwhelmed if release week coincides with a filing deadline in any region. Each risk has an owner, and each is reviewed at the weekly release meeting.",
    ],
    [
      "Review after release",
      "Four weeks after release the team holds a review. It looks at what went as planned, what did not, and what should change for the next major version. Support call volumes, migration results and customer feedback are gathered beforehand. The review is written up and shared with the whole company. Its purpose is to improve the process. It is not an occasion for assigning blame, and people are asked to speak plainly on that understanding.",
    ],
  ],
);

// ---------------------------------------------------------------------------

export const BUILT_FIXTURES: Fixture[] = [
  {
    key: "ops-review",
    origin: "built",
    markdown: OPS_REVIEW,
    shape: {
      size: "inlined",
      facts: [
        { text: "Revenue for the third quarter was $4.82 million" },
        { text: "the committee lowered it to 94% on July 20" },
        { text: "is now expected to open on November 17, 2026" },
        { text: "which Whitcombe attributes to the new second shift" },
        { text: "Driver turnover is running at 23% on an annualized basis." },
        { text: "The lease on the Dayton warehouse expires in March 2027" },
        { text: "will end support for the current version in June 2027" },
      ],
      distractors: [
        "$4.41 million",
        "originally 95%",
        "October 20, 2026",
        "Dayton warehouse flood",
        "212",
        "17 drivers",
        "Dana Whitcombe",
        "Priya Raman",
        "July 20",
        "$45,000",
        "$310,000",
        "$275,000",
      ],
      absent: ["35,000", "chair", "fourth-quarter revenue"],
    },
  },
  {
    key: "clinic-handbook",
    origin: "built",
    markdown: CLINIC_HANDBOOK,
    shape: {
      size: "inlined",
      facts: [
        { text: "Full-time staff accrue 18 days of paid leave a year" },
        { text: "takes effect on September 1, 2026" },
        { text: "approved by the clinic manager, Helen Abara" },
        { text: "any days beyond that are forfeited on January 31" },
      ],
      distractors: [
        "15 days",
        "August 3, 2026",
        "Tomas Reyes",
        "Samuel Pike",
        "Ruth Calder",
        "December 31",
        "8 days a year",
        "Up to 5 unused days",
        "41 of 46",
        "92%",
      ],
      absent: ["bereavement", "previous manager", "predecessor"],
    },
  },
  {
    key: "lease-summary",
    origin: "built",
    markdown: LEASE_SUMMARY,
    shape: {
      size: "inlined",
      facts: [
        { text: "Base rent is $9,600 a month in the first year" },
        { text: "the term begins on March 1, 2026" },
        { text: "giving 9 months of written notice" },
        { text: "a fee equal to 4 months of base rent" },
        { text: "represented by its property manager, Gordon Liddell" },
      ],
      distractors: [
        "$7,350",
        "January 22, 2026",
        "February 9, 2026",
        "12 months",
        "Irene Vasquez",
        "$19,200",
        "late fee of 5%",
      ],
      absent: ["14,700", "penalty", "signed by"],
    },
  },
  {
    key: "grant-report",
    origin: "built",
    markdown: GRANT_REPORT,
    shape: {
      size: "just-under",
      facts: [
        { text: "We enrolled 342 learners in year two" },
        { text: "the foundation agreed to revise it to 65%" },
        { text: "We request a grant of $195,000 for year three." },
      ],
      distractors: [
        "268",
        "320",
        "70%",
        "$180,000",
        "$150,000",
        "187",
        "$21,000",
        "June 18, 2026",
        "July 24, 2026",
      ],
      absent: ["155", "dropped out", "withdrew"],
    },
  },
  {
    key: "field-study",
    origin: "built",
    markdown: FIELD_STUDY,
    shape: {
      size: "deep",
      facts: [
        { text: "The Harbour Point lot has 240 spaces", heading: "Parking at Harbour Point" },
        { text: "Overall satisfaction averaged 7.4", heading: "Rider satisfaction scores" },
        {
          text: "The fieldwork and analysis cost $86,500 in the end",
          heading: "Cost of the fieldwork",
        },
        { text: "the pilot would begin on March 9, 2026", heading: "Proposed pilot schedule" },
      ],
      distractors: [
        "310 spaces",
        "6.9",
        "8.6",
        "4.8",
        "$92,000",
        "$74,000",
        "February 17, 2026",
        "Rafael Quint",
        "Dr. Imogen Hale",
      ],
      absent: ["cleanliness", "chaired"],
    },
  },
  {
    key: "release-plan",
    origin: "built",
    markdown: RELEASE_PLAN,
    shape: {
      size: "deep",
      facts: [
        { text: "only 45 agreed to take part", heading: "Beta programme" },
        {
          text: "The final decision rests with the chief product officer, Desmond Achterberg.",
          heading: "Go or no-go meeting",
        },
        { text: "General release is set for March 16, 2027.", heading: "Release day schedule" },
        { text: "if more than 2% of migrations fail", heading: "Rollback criteria" },
      ],
      distractors: [
        "60 customers",
        "Katrin Olsen",
        "February 23, 2027",
        "March 2, 2027",
        "threshold at 5%",
        "$29",
        "$32",
        "$55",
        "1,180 of 1,200",
        "Bettina Kruger",
      ],
      absent: ["Premium plan rises", "Premium plan stays", "weekend cover is led"],
    },
  },
];
