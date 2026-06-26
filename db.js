import './env.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('CRITICAL: SUPABASE_URL або SUPABASE_SERVICE_KEY відсутні в .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveVacancy({ company_name, job_title, job_location, job_url }) {
  if (!job_url || !company_name || !job_title) {
    throw new Error(`Validation Error: неповний об'єкт вакансії (url: ${job_url})`);
  }

  const { data, error } = await supabase
    .from('vacancies')
    .upsert(
      { company_name, job_title, job_location, job_url },
      { onConflict: 'job_url', ignoreDuplicates: true }
    )
    .select();

  if (error) {
    console.error(`[DB ERROR] ${job_url}:`, error.message);
    throw error;
  }

  // data.length > 0 — запис вставлено (нова вакансія)
  // data.length === 0 — спрацював ignoreDuplicates (вже існує)
  return data && data.length > 0;
}