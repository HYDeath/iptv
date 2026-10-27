import { SOURCES } from './sources.js'
import { createInstitutionModule } from './module.js'

export const institutionModules = SOURCES.map(spec => createInstitutionModule(spec))
