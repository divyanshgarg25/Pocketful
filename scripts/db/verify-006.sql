-- Assertions for 006. Any failure raises and aborts (ON_ERROR_STOP).
begin;
insert into auth.users(id,email) values ('aaaaaaaa-0000-4000-8000-0000000000f1','v@v.v'),('aaaaaaaa-0000-4000-8000-0000000000f2','w@w.w');
insert into profiles(id,name,timezone,home_lat,home_lng,home_label,max_distance_km,guilt_free_cap_minor,per_action_cap_minor,weekly_cap_minor,currency,opt_in_mood,opt_in_tracking,exploration_level)
 values ('aaaaaaaa-0000-4000-8000-0000000000f1','V','UTC',1,1,'x',5,100,6000,6000,'USD',true,true,'normal'),
        ('aaaaaaaa-0000-4000-8000-0000000000f2','W','UTC',1,1,'x',5,100,6000,0,'USD',true,true,'normal');
insert into approvals(id,user_id,action_type,payload,preview,amount_minor,money_out_minor,status,idempotency_key,expires_at,decided_at)
select ('bbbbbbbb-0000-4000-8000-00000000000'||g)::uuid,'aaaaaaaa-0000-4000-8000-0000000000f1','vault_move','{}','p',4000,4000,'approved','vk'||g,now()+interval '1h',now() from generate_series(1,2) g;

do $$
declare r jsonb;
begin
  -- 1. first execution within weekly cap passes, second would exceed it (counts the EXECUTING one)
  r := begin_execution('bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000f1','UTC');
  if (r->>'ok')::boolean is not true then raise exception 'expected first execution ok: %', r; end if;
  r := begin_execution('bbbbbbbb-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-0000000000f1','UTC');
  if r->>'code' is distinct from 'WEEKLY_CAP' then raise exception 'expected WEEKLY_CAP, got %', r; end if;
  -- 2. wrong owner cannot execute
  r := begin_execution('bbbbbbbb-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-0000000000f2','UTC');
  if r->>'code' is distinct from 'NOT_FOUND' then raise exception 'expected NOT_FOUND for other user, got %', r; end if;
  -- 3. already-executing cannot be started again
  r := begin_execution('bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000f1','UTC');
  if r->>'code' is distinct from 'BAD_STATUS' then raise exception 'expected BAD_STATUS, got %', r; end if;
  -- 4. zero weekly cap blocks any spend
  insert into approvals(id,user_id,action_type,payload,preview,amount_minor,money_out_minor,status,idempotency_key,expires_at,decided_at)
   values ('bbbbbbbb-0000-4000-8000-0000000000aa','aaaaaaaa-0000-4000-8000-0000000000f2','vault_move','{}','p',100,100,'approved','zk',now()+interval '1h',now());
  r := begin_execution('bbbbbbbb-0000-4000-8000-0000000000aa','aaaaaaaa-0000-4000-8000-0000000000f2','UTC');
  if r->>'code' is distinct from 'CAP_ZERO' then raise exception 'expected CAP_ZERO, got %', r; end if;
  -- 5. an outcome-bearing approval can never be re-run
  update approvals set status='executing', execution_outcome='{"x":1}' where id='bbbbbbbb-0000-4000-8000-000000000001';
  update approvals set status='failed' where id='bbbbbbbb-0000-4000-8000-000000000001';
  r := begin_execution('bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000f1','UTC', array['failed']);
  if r->>'code' is distinct from 'ALREADY_EXECUTED_SIDE_EFFECT' then raise exception 'expected ALREADY_EXECUTED_SIDE_EFFECT, got %', r; end if;
  -- 6. invalid timezone fails loudly
  begin
    perform begin_execution(gen_random_uuid(),'aaaaaaaa-0000-4000-8000-0000000000f1','Not/AZone');
    raise exception 'invalid tz should have raised';
  exception when invalid_parameter_value then null; end;
end $$;

-- 7. pocket/vault moves conserve money and create a missing destination
insert into pockets(user_id,kind,balance_minor,is_simulated) values ('aaaaaaaa-0000-4000-8000-0000000000f1','weekly',10000,true);
do $$
declare r jsonb; total bigint;
begin
  perform move_weekly_to_vault('aaaaaaaa-0000-4000-8000-0000000000f1','lock_in',4000);
  r := move_weekly_to_vault('aaaaaaaa-0000-4000-8000-0000000000f1','roll_over',7000);
  if r->>'code' is distinct from 'INSUFFICIENT' then raise exception 'expected INSUFFICIENT, got %', r; end if;
  r := move_pocket_balance('aaaaaaaa-0000-4000-8000-0000000000f1','weekly','holiday',1500);
  if (r->>'ok')::boolean is not true then raise exception 'pocket move failed: %', r; end if;
  select (select sum(balance_minor) from pockets where user_id='aaaaaaaa-0000-4000-8000-0000000000f1')
       + (select goal_balance_minor+rollover_balance_minor from vault where user_id='aaaaaaaa-0000-4000-8000-0000000000f1') into total;
  if total <> 10000 then raise exception 'money not conserved: %', total; end if;
end $$;

-- 8. capturing status accepted, bogus status still rejected
insert into groups(id,organizer_id,total_minor,currency,deadline,status) values ('cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000f1',6000,'USD',now()+interval '1d','pending');
insert into group_payments(id,group_id,friend_name,contact,share_minor,public_token,status) values (gen_random_uuid(),'cccccccc-0000-4000-8000-000000000001','A','a@b.c',3000,'tok-capturing','capturing');
do $$ begin
  begin
    insert into group_payments(id,group_id,friend_name,contact,share_minor,public_token,status) values (gen_random_uuid(),'cccccccc-0000-4000-8000-000000000001','B','b@b.c',3000,'tok-bogus','bogus');
    raise exception 'bogus status should be rejected';
  exception when check_violation then null; end;
end $$;
rollback;
