import type { SequenceCombo } from '../types/api';

/** Format sequence label without plane (just weight + sequence) */
export function formatSequenceLabel(seq: SequenceCombo): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

/** Get tooltip for sequence/weight combination focused on tumor progression */
export function getSequenceTooltip(weight: string | null, sequence: string | null): string {
  const key = `${weight || ''}-${sequence || ''}`.toLowerCase();
  
  // T1-weighted sequences
  if (key.includes('t1') && key.includes('gre')) {
    return `T1 GRE (Gradient Echo)

How to read: Fat and protein-rich fluid appear bright. Water appears dark. Provides sharp anatomical detail.

In craniopharyngioma: Cysts with bright signal contain the characteristic "machine oil" fluid (cholesterol, protein, keratin). Mixed bright/dark areas indicate complex cyst contents. Dark spots are often calcium.

Tracking progression:
• Measure and compare cyst dimensions across dates
• Look for new cysts or compartments forming
• Monitor signal intensity changes - brightening may indicate increased protein content or hemorrhage
• Check if solid components are growing`;
  }
  if (key.includes('t1') && key.includes('se')) {
    return `T1 SE (Spin Echo)

How to read: Classic anatomical sequence. Bright = fat, protein, blood products. Dark = water, calcium, air. Gray/white matter contrast is excellent.

In craniopharyngioma: Look for the typical heterogeneous (patchy) appearance with multiple cysts of varying brightness. Very bright cysts = high protein or old blood. Dark spots = calcium deposits (present in 90%+ of cases).

Tracking progression:
• Compare overall tumor size and shape
• Track individual cyst sizes - measure the largest diameter
• Note changes in cyst signal intensity
• Check pituitary stalk and optic chiasm position relative to prior scans`;
  }
  if (key.includes('t1') && !sequence) {
    return `T1-Weighted Imaging

How to read: Basic anatomical scan. Bright = fat, protein-rich fluid. Dark = water, CSF. Good gray-white matter differentiation.

In craniopharyngioma: The tumor typically appears heterogeneous with multiple cysts. Bright cysts contain "machine oil" fluid rich in cholesterol and keratin - this is nearly unique to adamantinomatous craniopharyngioma.

Tracking progression:
• Measure total tumor extent in all dimensions
• Count and measure individual cysts
• Compare position relative to optic chiasm, pituitary, hypothalamus
• Check ventricle size - enlargement suggests developing hydrocephalus`;
  }
  
  // T2-weighted sequences
  if (key.includes('t2') && key.includes('flair')) {
    return `T2 FLAIR

How to read: Like T2 but CSF signal is suppressed (dark). This makes abnormalities near fluid spaces much easier to see. Bright signal in brain tissue = edema or gliosis.

In craniopharyngioma: Cysts appear variable (bright to dark depending on protein content). Look for bright signal in adjacent brain tissue - this indicates edema or irritation from the tumor.

Tracking progression:
• Compare FLAIR signal in hypothalamus and surrounding brain
• New or increasing bright signal suggests tumor growth or invasion
• Monitor tumor margin clarity - blurring may indicate infiltration
• Check for new areas of brain edema`;
  }
  if (key.includes('t2') && key.includes('se')) {
    return `T2 SE (Spin Echo)

How to read: Water and fluid appear bright. Excellent for seeing cystic structures. CSF is very bright. Calcium appears dark.

In craniopharyngioma: Most cysts appear bright, but intensity varies with protein concentration. Very bright = watery; less bright = thicker "machine oil." Look for dark spots within cysts (calcium) and internal septations (walls between cyst chambers).

Tracking progression:
• Measure cyst sizes - rapid growth needs attention
• Count cyst compartments - new septations indicate complexity
• Assess optic chiasm: is it more stretched or displaced than before?
• Check third ventricle size - compression causes hydrocephalus`;
  }
  if (key.includes('t2') && key.includes('ssfse')) {
    return `T2 SSFSE (Fast Spin Echo)

How to read: Quick T2 sequence showing fluid as bright. Less detailed than standard T2 but good for overall cyst assessment.

In craniopharyngioma: Shows cyst architecture - number, size, and arrangement of chambers. Variable signal between cysts reflects different protein concentrations.

Tracking progression:
• Quick comparison of overall cyst dimensions
• Identify new cyst formation
• Check ventricle size for hydrocephalus
• Use standard T2 for detailed measurements`;
  }
  
  // Diffusion sequences
  if (key.includes('dwi')) {
    return `DWI (Diffusion-Weighted Imaging)

How to read: Measures water molecule movement. Restricted diffusion (bright signal) = water is trapped. Normal cyst fluid shows free diffusion (dark on DWI).

In craniopharyngioma: Cysts typically appear DARK (no restriction) - this helps distinguish from abscesses and epidermoid cysts which appear bright. Bright DWI signal in a cyst is unusual and may indicate very thick contents or infection.

Tracking progression:
• Cysts should remain dark on DWI across scans
• New bright signal is a red flag - investigate for infection or hemorrhage
• Useful for characterizing new cystic areas
• Compare with ADC map for confirmation`;
  }
  if (key.includes('dti')) {
    return `DTI (Diffusion Tensor Imaging)

How to read: Maps white matter fiber tracts. Color-coded by direction: red = left-right, green = front-back, blue = up-down. Shows whether nerve fibers are intact or disrupted.

In craniopharyngioma: Key tracts to identify are the optic tracts (vision), fornix (memory), and hypothalamic connections. Tracts may be displaced (pushed aside) or invaded by tumor.

Tracking progression:
• Compare tract position - new displacement suggests growth
• Assess tract integrity - thinning or gaps indicate damage
• Track optic tract appearance relative to visual symptoms
• Look for tract recovery or worsening over time`;
  }
  if (key.includes('asl')) {
    return `ASL (Arterial Spin Labeling)

How to read: Shows blood flow without contrast dye. High flow = bright signal. Cysts (no blood flow) appear dark. Solid vascular tissue appears bright.

In craniopharyngioma: Solid tumor components typically show low to moderate blood flow (less than meningiomas). Cystic areas show no flow.

Tracking progression:
• Compare blood flow in solid components across scans
• Increasing flow suggests active tumor growth
• New flow in previously cystic areas may indicate solid recurrence
• Useful for monitoring without contrast`;
  }
  
  // Susceptibility sequences  
  if (key.includes('swi') || key.includes('swan')) {
    return `SWI/SWAN (Susceptibility-Weighted)

How to read: Extremely sensitive to calcium, iron, and blood products - these appear as dark (black) areas. More sensitive than CT for detecting small calcifications.

In craniopharyngioma: Calcifications are the hallmark finding (>90% of cases). They appear as dark spots or clusters, often at cyst periphery. Old hemorrhage also appears dark.

Tracking progression:
• Calcification patterns are typically stable - use as reference landmarks
• New dark areas suggest fresh hemorrhage into cysts
• Compare calcification distribution
• Helps distinguish tumor from blood products`;
  }
  if (key.includes('gre') && !key.includes('t1')) {
    return `GRE (Gradient Echo)

How to read: Sensitive to magnetic field disturbances from calcium and blood. These cause dark "blooming" artifacts that appear larger than actual size.

In craniopharyngioma: Calcifications appear as dark blooming spots. Hemosiderin (old blood) also appears dark. Less sensitive than SWI but still useful.

Tracking progression:
• Calcification patterns are stable - good baseline reference
• New blooming suggests hemorrhage
• Compare with prior scans to identify changes
• Cross-reference with SWI for detailed assessment`;
  }
  
  return `${formatSequenceLabel({ weight, sequence } as SequenceCombo)}

MRI scan sequence for brain imaging. Different sequences highlight different tissue properties and are useful for various aspects of diagnosis and monitoring.`;
}
